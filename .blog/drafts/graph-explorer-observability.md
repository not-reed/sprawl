---
title: "When You Can't Trust the Answer: Building a Memory Explorer for a Multi-Stream AI"
date: 2026-02-27
tags: [memory, debugging, observability, graph, sqlite]
description: "Why conversational testing breaks down when an AI has five simultaneous memory retrieval streams, and how a direct SQLite explorer fixes it."
---

# When You Can't Trust the Answer: Building a Memory Explorer for a Multi-Stream AI

Suppose you're chatting with your AI companion and it correctly recalls that you mentioned a project deadline two weeks ago. You didn't explicitly store that fact. You just mentioned it in passing, mid-conversation, and the agent remembered.

But which memory system is responsible? Was it the observer, which compresses recent conversation into structured observations? The reflector, which periodically distills those observations into long-term memories? FTS5 full-text search? Cosine similarity over embeddings? Graph traversal from a related concept node? All five run simultaneously for every message. Any of them could have contributed. Often more than one does.

This question matters, and not just out of curiosity. If you can't identify which system retrieved a piece of information, you can't verify that the system is working correctly. You can't debug misfires. And you can't trust that what feels like "remembering" isn't occasionally just a confident-sounding hallucination.

## The Multi-Stream Problem

Construct's memory architecture is described in detail in earlier articles, but the short version is: there are two separate pipelines, each with multiple stages, all of which can inject context into a response.

The **write side** creates memories asynchronously after each response. The observer watches uncompressed messages and extracts structured observations. When observations accumulate past a threshold, the reflector distills them into persistent memories. Those memories are also run through an LLM to extract entities and relationships, which get written to a knowledge graph.

The **read side** runs at message time and has three modes. FTS5 full-text search finds keyword matches. Embedding search finds semantic neighbors. Graph traversal follows relationships from matched nodes to surface adjacent facts. The results from all three get merged, deduplicated by memory ID, and injected into the preamble of the agent's prompt.

On top of all that, observations from the current conversation are rendered directly into context, separate from the recalled memories, as a representation of what the agent "just noticed" about the ongoing thread.

That's five distinct channels. Each is operating correctly in isolation, each was tested in isolation, but the combination creates an opacity problem that pure conversational testing can't solve.

## Why Conversational Testing Fails Here

You can probe a single retrieval system pretty reliably. Ask a question you know is in FTS5, check the result. Store a memory, ask a semantically related question, see if it comes back. These tests work.

What doesn't work: testing emergence. The question "does the agent remember X?" has a true positive answer only if X comes back reliably from the right source, at the right confidence level, through the right channel. When something goes wrong (the agent seems to have "forgotten" something, or confabulates details that were never said), you're chasing a ghost through five overlapping systems. Which one failed? Which one is pulling in something it shouldn't?

Making this worse: AI responses aren't reliably falsifiable by introspection. The agent *can* read its own logs and query the database (it has self-aware tools for that), but asking "why did you say that?" in conversation will usually get you a plausible-sounding explanation that may have no relationship to the actual retrieval path. It won't spontaneously tell you that a fact came in through graph traversal at depth 2 via the concept node "deadline" with a cosine similarity of 0.41. It just knows the fact was in context, and it used it.

Conversational testing, then, can detect gross failures (the agent answers as if a core memory doesn't exist), but it's poor at detecting subtle misfires, partial retrievals, or silent failures where the right information was in the database but never surfaced.

## A Direct Window Into the Database

The graph explorer is not a debugging tool in the traditional sense. There's no stepping through code, no breakpoints, no exception traces. It's a read-only UI sitting directly on top of the same SQLite database the agent writes to.

The server is a small Hono app with four route groups, each exposing a slice of the memory storage:

```typescript
app.route('/api/memories', memoriesRoutes)
app.route('/api/graph', graphRoutes)
app.route('/api/observations', observationsRoutes)
app.route('/api/stats', statsRoutes)
```

The key point is that it's not a separate data store, not a mirror, not an export. It opens the same database file. When you look at the explorer, you're looking at exactly what the agent sees.

## What the Three Views Show

**The Graph view** renders the knowledge graph (entities and relationships extracted from memories) as a force-directed canvas. Nodes are sized by their edge count (well-connected concepts are larger) and colored by type: blue for people, green for places, orange for concepts, pink for events. Clicking a node opens a detail panel listing its relationships, their relation labels, and the raw memories that caused those relationships to be created.

```typescript
graphRoutes.get('/nodes/:id/memories', async (c) => {
  const memoryIds = await getRelatedMemoryIds(db, [id])
  const memories = await db
    .selectFrom('memories')
    .selectAll()
    .where('id', 'in', memoryIds)
    .where('archived_at', 'is', null)
    .orderBy('created_at', 'desc')
    .execute()
  // ...
})
```

This bidirectional linkage (graph node to source memories, memory to associated graph nodes) is what makes the view useful. You're not just seeing that "Python" is a concept in the graph. You can follow the edge to see which specific remembered facts led to it being there, and you can walk the edges from "Python" to adjacent nodes like "side project" or "learning" to understand what the agent believes is related.

Double-clicking a node triggers traversal expansion, fetching neighbors at configurable depth and merging them into the running simulation. This mirrors exactly what the retrieval engine does when it uses graph traversal: start from a matched node, follow edges, return whatever's nearby.

**The Memory Browser** exposes the memories table directly. A search bar drives the same `recallMemories` function the agent uses, with one useful addition: a mode selector that lets you force FTS5-only or embedding-only retrieval, or let both run in sequence (the default "auto" mode).

```typescript
const results = await recallMemories(db, q, opts)
const cleaned = results.map(({ embedding, ...rest }) => rest)
```

Each result card shows the `matchType` field (`fts5` or `embedding`), so you can see which retrieval path found it, and the similarity score where applicable. Expanding a card shows which graph nodes it contributed to. This lets you answer the question "when the agent recalls this memory, what graph relationships does it also implicitly activate?"

**The Observation Timeline** is the most diagnostic of the three. You select a conversation and see its observations: timestamped, prioritized notes extracted by the observer from raw message content. Each observation shows its `generation` count (how many reflector passes it has survived without being superseded), and you can toggle to show superseded observations alongside active ones.

```typescript
observationsRoutes.get('/conversations/:id/all', async (c) => {
  const observations = await db
    .selectFrom('observations')
    .selectAll()
    .where('conversation_id', '=', id)
    .orderBy('generation', 'desc')
    .orderBy('observation_date', 'desc')
    .execute()
  // ...
})
```

This view answers a category of question that's otherwise nearly impossible to investigate: "does the agent remember that I said X in conversation Y?" The observations are the bridge between raw messages (which eventually scroll out of context) and long-term memories (which are distilled). If a fact was extracted by the observer, it's here, with a timestamp, a priority, and a record of whether it was later absorbed into a memory or superseded by something more recent.

## The Verification Workflow

The practical use is roughly: have a conversation, notice something the agent seems to know (or not know), open the explorer and trace backward.

If the agent correctly recalled a fact: search for it in the Memory Browser. Is it there? Did it come back via FTS5 or embedding? Click into it. Which graph nodes does it link to? Cross-reference with the Graph view to see whether those nodes are well-connected (likely to surface through traversal) or isolated (might only appear if searched directly).

If the agent seems to have forgotten something: check the Observation Timeline for the relevant conversation. Was the fact extracted as an observation? If not, why not? Was the conversation too short to trigger the observer threshold? If it was extracted, check whether it was later superseded and never promoted to a memory. If it was promoted, search for it in the Memory Browser and confirm the embedding exists.

If the agent said something that wasn't in any stored memory: this is the hallucination check. Search the Memory Browser aggressively. Search for it in the graph. If nothing comes back, it wasn't retrieved. The agent generated it. That's not always wrong (some answers should come from model knowledge, not stored facts) but knowing the difference matters.

## Trust Through Transparency

There's a class of AI system failure that's worse than a hard error: confident wrongness. A system that crashes is immediately obvious. A system that retrieves the wrong memory, or constructs a plausible-but-false recollection from semantic neighbors, can pass conversational tests while silently degrading in quality.

The graph explorer doesn't prevent this, but it makes it discoverable. When you can see exactly what's in the database, exactly what was extracted from which conversation, and exactly how a search query maps onto the retrieval results the agent would receive, the system stops being a black box that happens to pass your spot checks.

That matters especially for a personal companion, where the agent's understanding of you accumulates over months. The investment in that relationship is real, and the cost of a corrupted or degraded memory store is proportionally high. A tool that lets you periodically audit what the agent actually knows (not what it claims to know, but what's literally in the rows and edges and observations) is not optional instrumentation. It's the only way to maintain confidence that the system is doing what it's supposed to do.
