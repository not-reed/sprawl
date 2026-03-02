# Cairn

*Last updated: 2026-03-01 -- Initial documentation*

## Overview

Memory substrate shared by Construct, Cortex, and Deck. Provides the observe-reflect-promote-graph pipeline that turns raw messages into structured long-term memories with entity relationships.

Published as `@repo/cairn` in the pnpm workspace.

## How it works

### Memory pipeline

```
Messages ──> Observer ──> Observations ──> Reflector ──> Condensed observations
                              │                              │
                              ▼                              │
                          Promoter ◄─────────────────────────┘
                              │
                              ▼
                          Memories ──> Graph extractor ──> Nodes + Edges
```

### MemoryManager (`packages/cairn/src/manager.ts`)

Central facade class. Constructed with a Kysely DB instance and config (API key, worker model, embedding model). Methods:

- `runObserver(conversationId)` -- Compress un-observed messages into observations. Triggered when unobserved token count exceeds 3000. Batches messages at 16K tokens per batch. Advances watermark per batch for crash safety.
- `runReflector(conversationId)` -- Condense observations when total tokens exceed 4000. Supersedes old observations, creates new generation.
- `promoteObservations(conversationId)` -- Promote medium/high-priority observations to the `memories` table. Embedding-based dedup (threshold: 0.85 cosine similarity). Only novel observations get graph extraction.
- `processStoredMemory(memoryId, content)` -- Extract entities/relationships from a memory into the knowledge graph.
- `buildContext(conversationId)` -- Returns observation text + un-observed messages for context injection. Priority-based budget eviction when observations exceed token limit.

### Observer (`packages/cairn/src/observer.ts`)

LLM-powered message compressor. Takes a batch of messages, outputs structured observations:
- Each observation has: content, priority (low/medium/high), observation_date
- Sanitizes output, detects degenerate responses
- Tracks token usage

### Reflector (`packages/cairn/src/reflector.ts`)

LLM-powered observation condenser. When observation tokens exceed threshold:
- Identifies redundant/outdated observations to supersede
- Creates new condensed observations at generation N+1
- Validates superseded IDs against actual observation set

### Promoter (in MemoryManager)

Bridges observations to long-term memories:
1. Find unpromoted medium/high-priority observations
2. Generate embedding for each
3. Compare against all existing memory embeddings
4. If max cosine similarity < 0.85, store as memory + trigger graph extraction
5. Mark all candidates as promoted regardless of outcome

### Graph extraction (`packages/cairn/src/graph/`)

- `extract.ts` -- LLM extracts entities (name, type, aliases) and relationships from memory content
- `index.ts` -- Orchestrates: extract, upsert nodes (with embedding-based merge for aliases), upsert edges
- `queries.ts` -- Node/edge CRUD, FTS5 + embedding hybrid search, BFS graph traversal, node dedup

### Embeddings (`packages/cairn/src/embeddings.ts`)

- `generateEmbedding(apiKey, text, model)` -- OpenRouter embedding API call
- `cosineSimilarity(a, b)` -- Vector similarity for dedup and search

### Context building (`packages/cairn/src/context.ts`)

- `renderObservations(obs)` -- Format observations as markdown text
- `renderObservationsWithBudget(obs)` -- Priority-based eviction when over token budget (default: 2000 tokens). Evicts low priority first, then medium.
- `buildContextWindow()` -- Full context assembly

### DB layer (`packages/cairn/src/db/`)

- `types.ts` -- `CairnDatabase` type: memories, conversations, messages, observations, graph_nodes, graph_edges, ai_usage
- `queries.ts` -- `storeMemory`, `recallMemories` (FTS5 + embedding hybrid), `updateMemoryEmbedding`, `forgetMemory`, `trackUsage`

## Exports

The package has multiple entry points:

```
@repo/cairn             # MemoryManager, types, observer, reflector, context, tokens
@repo/cairn/embeddings  # generateEmbedding, cosineSimilarity
@repo/cairn/graph       # processMemoryForGraph
@repo/cairn/graph/queries # searchNodes, traverseGraph, upsertNode, upsertEdge, etc.
@repo/cairn/db/types    # CairnDatabase, table types
@repo/cairn/db/queries  # storeMemory, recallMemories, etc.
```

## Key files

| File | Role |
|------|------|
| `src/index.ts` | Barrel exports |
| `src/manager.ts` | MemoryManager class (main facade) |
| `src/observer.ts` | Message -> observations LLM worker |
| `src/reflector.ts` | Observation condenser LLM worker |
| `src/context.ts` | Observation rendering with budget eviction |
| `src/embeddings.ts` | OpenRouter embeddings + cosine similarity |
| `src/tokens.ts` | Token estimation (char/4 heuristic) |
| `src/types.ts` | All shared types |
| `src/db/types.ts` | CairnDatabase schema type |
| `src/db/queries.ts` | Memory CRUD, FTS5 hybrid recall, usage tracking |
| `src/graph/index.ts` | processMemoryForGraph orchestrator |
| `src/graph/extract.ts` | LLM entity/relationship extraction |
| `src/graph/queries.ts` | Graph CRUD, search, traversal |

## Consumers

- **Construct** -- Full pipeline: observer/reflector run after each conversation turn, memories stored via tools, graph extracted from stored memories, context built for each processMessage() call
- **Cortex** -- Price + news messages fed through observer -> promoter -> reflector. Analyzer uses recallMemories + graph traversal for signal generation.
- **Deck** -- Read-only: queries memories, observations, graph for visualization

## Architecture decisions

- **Batched observer** -- Messages are split into batches of max 16K tokens to avoid overwhelming the worker LLM. Watermark advances per batch so partial failures preserve progress.
- **Embedding-based dedup** -- Promoter compares observation embeddings against all existing memories. Prevents redundant memory accumulation across conversations.
- **Priority-based eviction** -- When observations exceed context budget, low-priority observations are evicted first. Ensures the most important context survives token limits.
- **Separate from Construct** -- Extracted as a shared package so Cortex can use the same memory pipeline without depending on Construct.

## Related documentation

- [Memory System](../features/memory.md) -- Construct's use of Cairn
- [Cortex](../apps/cortex.md) -- Market data memory pipeline
- [Deck](../apps/deck.md) -- Memory visualization
