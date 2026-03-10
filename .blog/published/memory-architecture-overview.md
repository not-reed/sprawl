---
title: "Construct's Memory System: An Architecture Overview"
date: 2026-02-26
tags: [memory, architecture, sqlite, observational-memory]
description: "How Construct's three-layer memory system turns ephemeral chat messages into durable, retrievable knowledge."
---

# Construct's Memory System: An Architecture Overview

Most chat applications treat memory as an afterthought, a rolling window of recent messages that evaporates when the context fills. Construct is a personal AI that runs as a Telegram bot, built to remember what matters about you across conversations that span weeks or months. Not just what you said recently, but the meaning extracted from it.

This is a high-level tour of how that memory system is structured. Two follow-up articles cover the implementation in depth; this one sets the stage.

## Why This Is Hard

The naive approach to conversational memory is to store every message and replay them all. It breaks down in two ways. First, there's a scale problem: a conversation spanning weeks or months blows past any context window you care to set. Second, there's a quality problem: raw messages are noisy. They're full of pleasantries, corrections, tangents, and off-the-cuff remarks that dilute the signal when replayed verbatim.

What you actually want a personal AI to remember isn't the transcript but the meaning extracted from it. That you started a new job. That you prefer terse responses. That you mentioned your sister is visiting next month.

The memory architecture in Construct was built to close that gap. It draws direct inspiration from Mastra's Observational Memory pattern and extends it with a knowledge graph and multi-modal retrieval layer.

## Prior Art: OpenClaw's Approach

Another open-source personal AI handles this problem differently. [OpenClaw](https://openclaw.ai/) (formerly Clawdbot), a personal assistant that integrates with Telegram, WhatsApp, Discord, and others, takes a file-based approach to persistent memory. Its memory system is, as their docs put it, "just Markdown files in the agent workspace": a `MEMORY.md` file for long-term curated facts, and daily notes (`memory/YYYY-MM-DD.md`) for short-term context.

The upside is simplicity: memory is human-readable, editable, and backed up with the rest of the workspace. But it has a fundamental dependency: the model has to choose to write things down. OpenClaw's own FAQ acknowledges this: "Memory keeps forgetting things." The recommended workaround is explicitly asking the bot to save important facts, because the model doesn't always proactively persist information on its own.

The retrieval side has a similar gap. OpenClaw pulls relevant memory files back into active context during conversations, but the mechanism is straightforward text search over markdown. If the user asks about "restaurants" but the relevant memory says "Alice introduced me to Nightshade" without the word "restaurant" anywhere in the file, that connection is invisible to a keyword-based search.

Construct's memory retrieval addresses this with a three-layer pipeline: FTS5 full-text search for exact keyword matches, cosine similarity over vector embeddings for semantic associations (catching "restaurants" → "Nightshade" even without shared vocabulary), and knowledge graph traversal for relational connections (walking edges like `Alice -> [introduced to] -> Nightshade -> [is a] -> restaurant`). Each layer covers gaps the others miss.

On the writing side, Construct stores every raw message permanently in the database. Nothing is ever discarded. The observational memory pipeline doesn't replace stored messages; it replaces them _in the context window_. Once a chunk of conversation has been compressed into observations, the agent sees the condensed observations plus only the recent unobserved messages, rather than replaying the entire transcript. But the full history remains in SQLite, searchable and intact. The observations are a compression layer for context assembly, not a lossy replacement for storage.

This sidesteps OpenClaw's core failure mode entirely. There's no dependency on the model choosing to write things down. Every message is stored automatically, and the observation pipeline ensures the meaning of older conversations stays in the agent's working context even after the raw messages rotate out of the context window.

## The Memory Layers

The system manages several layers of memory, each serving a different purpose:

**Raw messages** are the foundation. Every message sent or received is stored permanently in SQLite. Nothing is discarded. These are searchable via FTS5 full-text search, vector embeddings, and the knowledge graph, so even a casual remark from months ago can surface if it's relevant to the current conversation.

**Curated memories** are things the agent stores via the `memory_store` tool, tagged with a category and embedded for semantic search. These are higher-signal than raw messages: the agent (or user) decided this fact was worth keeping as a standalone record. They get their own embeddings and feed into the knowledge graph.

**Observations** are automatically derived from conversation history. A background process watches each conversation and compresses accumulating messages into structured, prioritized notes. When observations pile up, a second process (the reflector) condenses them further. Observations don't replace the stored messages; they replace them in the context window, so the agent gets a compressed view of older conversation without losing access to the raw data. Even this compressed view is capped at 8,000 tokens: when observations exceed the budget, lower-priority and older entries are evicted from the working set, with the retrieval pipeline (FTS5, embeddings, graph) serving as the escape hatch for anything that drops out.

**Identity files** (SOUL.md, IDENTITY.md, USER.md) live in the extensions directory and are injected directly into the system prompt. These define the agent's personality, metadata, and user context. They're the most static layer, edited by hand or by the agent's self-edit tools.

**The knowledge graph** extracts entities and relationships from curated memories and stores them as nodes and edges. This enables retrieval by association: finding memories connected by relationship chains that text search alone would miss.

All of this lives in SQLite, managed through Kysely:

```
messages           - raw conversation turns (permanent, searchable)
memories           - curated facts stored via memory_store
observations       - auto-compressed conversation summaries
graph_nodes        - entities extracted from memories (people, places, concepts)
graph_edges        - relationships between those entities
conversations      - per-channel state, including observation watermark
```

## The Architecture at a Glance

```
 Every message
      │
      ├──► stored permanently in messages table (searchable via FTS5 + embeddings)
      │
      │  (post-response, async, when token threshold exceeded)
      ▼
 ┌─────────────┐
 │   Observer  │  ──► Structured observations (priority: low/med/high)
 └─────────────┘
      │
      │  (if observation token count exceeds threshold)
      ▼
 ┌─────────────┐
 │  Reflector  │  ──► Condensed observations (supersedes old ones)
 └─────────────┘

 Curated Memories (via memory_store)
      │
      │  (on store, async, non-blocking)
      ▼
 ┌───────────────────┐
 │  Graph Extractor  │  ──► Nodes + Edges in graph_nodes / graph_edges
 └───────────────────┘

 Identity Files (SOUL.md, IDENTITY.md, USER.md)  ──► System prompt

 Incoming Message
      │
      ▼
 ┌──────────────────────────────────────────┐
 │            Retrieval Pipeline            │
 │                                          │
 │  passive: recent memories + embedding    │
 │  active:  FTS5 / embedding / graph tool  │
 └──────────────────────────────────────────┘
      │
      ▼
 Context Preamble → Agent → Response
```

## How a Message Gets Processed

Every message flows through `processMessage()` in `src/agent.ts`. The memory system touches it at three distinct moments.

**Before** the agent sees the message, the pipeline builds context. It loads active observations for the conversation (the compressed history), fetches the unobserved messages since the last observation watermark (the recent raw history), and runs passive memory retrieval against the incoming message. The result is a context preamble injected at the top of the prompt: observations, recent memories, and semantically relevant memories, all assembled before the LLM is invoked.

**During** the agent's turn, it has access to memory tools: `memory_store` to write curated memories, `memory_recall` to search across all stored memories (using the full FTS5 + embedding + graph pipeline), and `memory_graph` to traverse the knowledge graph directly. These are active retrieval; the agent decides when to use them.

**After** the response is sent, the system runs the observer and reflector asynchronously and non-blocking. The conversation already got its answer; the memory compression happens in the background, ready for the next turn.

This sequencing matters. The agent responds at full speed. Memory maintenance never adds latency to the user experience.

## The Dual Pipeline Design

The separation between the **writing pipeline** (observer → reflector → graph) and the **reading pipeline** (passive injection + active retrieval). These are independent concerns that run at different times.

The writing side is triggered by time and token thresholds. It only fires when enough raw material has accumulated to be worth compressing. The reading side runs on every single message, drawing on whatever has already been compressed and indexed.

This means the memory system degrades gracefully. On day one, there are no observations and no graph nodes, so the agent falls back to a rolling window of recent messages. Over time, as observations accumulate and the graph fills in, the context Construct brings to each conversation gets richer and more structured without requiring any explicit configuration from the user.

## Going Deeper

The two follow-up articles cover the implementation in detail:

The _Observer, Reflector, Graph_ article digs into the writing side: how raw messages are compressed into observations, how observations are condensed across generations by the reflector, and how stored memories spawn a knowledge graph of entities and relationships.

The _Three Ways to Find a Memory_ article covers the reading side: the waterfall of FTS5 full-text search, cosine similarity over embeddings, and graph traversal that backs the `memory_recall` tool, and the passive auto-injection that runs before the agent even starts thinking.

Together, the two pipelines are what give Construct something closer to the memory structure of a person than a chatbot: compressed, semantically indexed, queryable by meaning, and always available without needing to be asked.
