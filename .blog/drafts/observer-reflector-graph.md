---
draft: true
title: "Observer and Reflector: How a Personal AI Compresses Conversation Into Memory"
date: 2026-02-26
tags: [memory, observer, reflector, mastra]
description: "How Construct compresses raw conversation into observations, reflections, and graph relationships using a background pipeline."
---

# Observer and Reflector: How a Personal AI Compresses Conversation Into Memory

Most chatbot memory systems are simple: keep the last N messages, truncate when you hit the context limit, hope the important stuff isn't in the part you dropped. Construct takes a different approach, inspired by [Mastra's Observational Memory](https://mastra.ai/) and adapted for a personal companion context.

## The Problem With Rolling Windows

When you talk to a friend over months, they don't remember your last twenty sentences. They remember a compressed, semantically meaningful summary: that you changed jobs in March, that you're allergic to shellfish, that you're worried about your mom. The actual conversational text is long gone. What remains are observations.

A rolling message window doesn't behave this way. It loses old context abruptly. The conversation from two weeks ago simply vanishes when the window fills. Worse, the raw messages are noisy: full of pleasantries, corrections, tangents, and meta-discussion that adds little to a long-term model of the user.

Mastra's observational memory pattern addresses this directly. Instead of storing raw messages, compress them into structured observations that capture what matters. Construct borrows the idea of their two-stage pipeline, running an **observer** that compresses raw messages and a **reflector** that compresses accumulated observations. On top of that sits a knowledge graph layer extracted from explicitly curated memories and high-priority observations.

## Stage 1: The Observer

The observer is triggered post-response, non-blocking:

```typescript
// src/agent.ts
memoryManager.runObserver(conversationId)
  .then((ran) => {
    if (ran) {
      return memoryManager.runReflector(conversationId)
    }
  })
  .catch((err) => agentLog.error`Post-response observation failed: ${err}`)
```

It only runs when unobserved messages cross a token threshold (3,000 tokens estimated at 4 chars/token). Below that, it's free: no API call, no latency.

```typescript
// src/memory/index.ts
export const OBSERVER_THRESHOLD = 3000
export const REFLECTOR_THRESHOLD = 4000

async runObserver(conversationId: string): Promise<boolean> {
  const unobserved = await this.getUnobservedMessages(conversationId)
  const tokenCount = estimateMessageTokens(unobserved)
  if (tokenCount < OBSERVER_THRESHOLD) return false
  // ...
```

The "unobserved messages" are those after the last observation watermark, a stored pointer to the most recently compressed message. When the threshold is crossed, those raw messages get sent to a worker LLM. The prompt is longer than what's shown here, but the core instructions boil down to:

```
You are an observation extractor. Extract the key information as
bullet-point observations.

- Assign priority: "high" (decisions, commitments), "medium" (general
  context), "low" (small talk)
- Preserve concrete details: names, numbers, dates, preferences
- Omit pleasantries, filler, and meta-discussion about the AI itself
```

The result is a small set of typed observations:

```typescript
interface Observation {
  id: string
  conversation_id: string
  content: string           // "User has a dentist appointment March 5th at 9am"
  priority: 'low' | 'medium' | 'high'
  observation_date: string  // when the thing happened, not when it was observed
  generation: number        // 0 = observer output, 1+ = survived reflector rounds
  superseded_at: string | null
  token_count: number
}
```

The `generation` field tells you how many rounds of condensation a piece of information has survived.

## Stage 2: The Reflector

Once total observation tokens cross 4,000, the reflector kicks in. Its job is to merge, prune, and tighten:

```
You are an observation condenser. Take a set of observations and
produce a tighter, more organized set.

- Combine related observations into single, richer observations
- Remove observations superseded by newer information
- Preserve high-priority items (decisions, commitments)
- Low-priority items can be dropped if they add no lasting value
```

The reflector receives observations with their IDs, and returns both new condensed observations and a list of IDs to mark superseded.

```typescript
// src/memory/reflector.ts
// Validate superseded IDs -only allow IDs that were in the input
const inputIds = new Set(input.observations.map((o) => o.id))
result.superseded_ids = result.superseded_ids.filter(
  (id) => typeof id === 'string' && inputIds.has(id),
)
```

You can't trust an LLM to return valid database IDs without validating them. The reflector is allowed to supersede anything it was given. Nothing more.

Superseded observations aren't deleted. They're soft-tombstoned with a `superseded_at` timestamp. The active observations are those with `superseded_at IS NULL`. This preserves the audit trail and allows rollback if something goes wrong.

## How Context Gets Assembled

At the start of each conversation turn, the agent builds a context window:

```typescript
// src/agent.ts
const { observationsText, activeMessages, hasObservations } =
  await memoryManager.buildContext(conversationId)

if (hasObservations) {
  historyMessages = activeMessages   // only unobserved messages
} else {
  historyMessages = await getRecentMessages(db, conversationId, 20)
}
```

Observations are rendered as a stable text block:

```typescript
// src/memory/context.ts
export function renderObservations(observations: Observation[]): string {
  const lines = observations.map((o) => {
    const priority = o.priority === 'high' ? '!' : o.priority === 'low' ? '~' : '-'
    return `${priority} [${o.observation_date}] ${o.content}`
  })
  return lines.join('\n')
}
```

Which produces something like:

```
! [2025-01-15] User has a dentist appointment on March 5th at 9am
- [2025-01-20] User mentioned they enjoy hiking on weekends
~ [2025-01-22] User said the weather was nice today
```

This block gets injected into the context preamble, prepended to the user message, not the system prompt. The system prompt stays static (and prompt-cacheable). The observations are dynamic per conversation, but they're deterministic enough to be stable across turns until the next observation cycle.

In practice, the raw `renderObservations` output passes through a budget gate before it reaches the preamble. `renderObservationsWithBudget()` caps the rendered observations at 8,000 tokens. When observations exceed the budget, the function sorts by priority (high first) and recency (newest first within the same priority tier), greedily packs from the top, then re-sorts the survivors chronologically for coherent reading. This is safe because observations that fall off the window are still reachable through FTS5, embeddings, and graph retrieval. The observation window is a working set, not the only copy.

## What This Looks Like in Practice

Over a long conversation, the observer/reflector pipeline produces a layered context structure:

- **Generation 0 observations**: Direct compressions of raw conversation chunks, dense but still specific
- **Generation 1+ observations**: Reflector-condensed summaries, broader and higher information density

Each layer is progressively more compressed and longer-lived. Raw messages are kept in the database permanently but rotate out of the context window as observations take over. Observations get refined repeatedly.

The knowledge graph (covered in the companion retrieval article) extracts entities and relationships from curated memories stored via `memory_store`. High-priority observations are also promoted into the memory store after deduplication, so they feed into the graph passively too.

## Tradeoffs

**Cost**: Every observation cycle costs an LLM call. The worker model is configurable (`MEMORY_WORKER_MODEL` env var), so you can use a cheap fast model rather than the main reasoning model. On the other hand, observations dramatically shrink the working context compared to stuffing raw message history into every request. Whether the extra worker call costs more than the token savings on the main model is genuinely unclear.

**Accuracy**: Compression loses information. The observer has to decide what's worth keeping. Its prompt instructs it to "omit pleasantries, filler, and meta-discussion," but "meta-discussion" is a judgment call. A conversation that's mostly about the AI's own behavior might be poorly summarized.

**Latency**: None. Observation runs post-response, asynchronously. The user gets their reply first, and the memory pipeline catches up in the background.

## Summary

Mastra's observer/reflector pattern answers a question that most production LLM apps ignore: what do you do when conversation history grows beyond what fits in a context window? Rolling truncation is fast but lossy. RAG with vector search is powerful but adds infrastructure complexity and retrieval latency.

Observation-based compression sits in between: it uses an LLM to do intelligent compression, but produces a deterministic, structured artifact (typed observations with priorities and dates) rather than a fuzzy embedding. The result is predictable, auditable, and cheap to re-render.

The generation counter is a proxy for information durability: the facts that survive multiple rounds of compression are the ones that really matter.
