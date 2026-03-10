---
title: Cairn
description: "Memory substrate: observer/reflector/promoter, embeddings, graph"
---

# Cairn

## Overview

Memory substrate shared by Construct, Cortex, Loom, and Deck. Provides the observe-reflect-promote-graph pipeline that turns raw messages into structured long-term memories with entity relationships.

Published as `@repo/cairn` in the pnpm workspace.

## Memory Pipeline

```
Messages ──> Observer ──> Observations ──> Reflector ──> Condensed observations
                              |                              |
                              v                              |
                          Promoter <─────────────────────────┘
                              |
                              v
                          Memories ──> Graph extractor ──> Nodes + Edges
```

The pipeline runs after every conversation turn (fire-and-forget, non-blocking):

1. **Observer** compresses un-observed messages into dated observations
2. **Reflector** condenses observations when they grow too large
3. **Promoter** bridges high-value observations into long-term memories
4. **Graph extractor** pulls entities and relationships from promoted memories

## MemoryManager (`src/manager.ts`)

Central facade class. Constructed with a Kysely DB instance and config (API key, worker model, embedding model).

### Configuration

```typescript
interface CairnOptions {
  observerPrompt?: string; // Override default observer system prompt
  reflectorPrompt?: string; // Override default reflector system prompt
  entityTypes?: string[]; // Override default graph entity types
}
```

Apps can subclass MemoryManager to customize behavior (e.g., Construct's `ConstructMemoryManager` adds `expires_at` support and `telegram_message_id` selection).

### Core Methods

- **`runObserver(conversationId)`** -- Compress un-observed messages into observations. Triggered when unobserved token count exceeds 3000. Batches messages at 16K tokens per batch. Advances watermark per batch for crash safety.
- **`runReflector(conversationId)`** -- Condense observations when total tokens exceed 4000. Supersedes old observations, creates new generation.
- **`promoteObservations(conversationId)`** -- Promote medium/high-priority observations to the `memories` table. Embedding-based dedup (threshold: 0.85 cosine similarity). Only novel observations get graph extraction.
- **`processStoredMemory(memoryId, content)`** -- Extract entities/relationships from a memory into the knowledge graph.
- **`buildContext(conversationId)`** -- Returns observation text + un-observed messages for context injection. Priority-based budget eviction when observations exceed token limit.

### Protected Hooks (for subclasses)

- **`getUnobservedMessages()`** -- Override to select additional columns (e.g., `telegram_message_id`)
- **`getActiveObservations()`** -- Override to add filtering (e.g., `expires_at` for time-bound observations)
- **`storeObservation()`** -- Override to write extra columns

## Observer (`src/observer.ts`)

LLM-powered message compressor. Takes a batch of messages, outputs structured observations.

**Trigger**: Called after every `processMessage()` response. Only runs if un-observed messages exceed `OBSERVER_THRESHOLD` (3000 estimated tokens).

**Process**:

1. `getUnobservedMessages()` loads messages after the watermark (uses `rowid` comparison for sub-second ordering)
2. Messages are formatted as `[timestamp] role: content` and sent to the worker LLM
3. The LLM returns JSON observations, each with `content`, `priority`, and `observation_date`
4. Observations are validated (content must be non-empty, priority must be `low`/`medium`/`high`) and stored
5. Watermark (`observed_up_to_message_id`) advances to the last processed message ID
6. `observation_token_count` is updated with the cumulative token estimate
7. Usage tracked in `ai_usage` with source `observer`

**Prompt rules**:

- Extract key information as self-contained bullet points
- Assign priority: `high` (decisions, commitments, important facts), `medium` (general context), `low` (small talk)
- Preserve concrete details: names, numbers, dates, preferences
- Omit pleasantries and filler

The default prompt is exported as `DEFAULT_OBSERVER_PROMPT`. Apps can override it via `CairnOptions.observerPrompt`.

## Reflector (`src/reflector.ts`)

LLM-powered observation condenser.

**Trigger**: Called automatically after the observer runs. Only runs if active (non-superseded) observations exceed `REFLECTOR_THRESHOLD` (4000 estimated tokens).

**Process**:

1. Active observations are loaded and formatted as `[id] (priority, date) content`
2. Sent to the worker LLM with the reflector system prompt
3. The LLM returns new condensed observations and a list of `superseded_ids` to retire
4. Superseded observations have their `superseded_at` set (soft delete). IDs validated against input set.
5. New observations inserted with `generation = max(input generations) + 1`
6. `observation_token_count` recalculated from active set
7. Usage tracked with source `reflector`

The default prompt is exported as `DEFAULT_REFLECTOR_PROMPT`.

## Promoter (in MemoryManager)

Bridges observations to long-term memories:

1. Find unpromoted medium/high-priority observations
2. Generate embedding for each
3. Compare against all existing memory embeddings
4. If max cosine similarity < 0.85, store as memory + trigger graph extraction
5. Mark all candidates as promoted regardless of outcome

## Graph Extraction (`src/graph/`)

### Entity Extraction (`extract.ts`)

LLM extracts entities (name, type, aliases) and relationships from memory content. Default entity types: `person`, `place`, `concept`, `event`, `entity`. Configurable via `CairnOptions.entityTypes`.

Exported: `DEFAULT_ENTITY_TYPES`, `extractEntities()`.

### Graph Processing (`index.ts`)

`processMemoryForGraph()` orchestrates:

1. Call `extractEntities()` with the memory content
2. Upsert each entity as a node (matched by canonical name + type). Descriptions only filled in if existing node lacks one.
3. Upsert each relationship as an edge. Existing edges (same source, target, relation) get `weight` incremented.
4. If a relationship references an entity not in the current extraction, look for it in the existing graph or create a new `entity`-typed node.
5. Usage tracked with source `graph_extract`

### Graph Queries (`graph/queries.ts`)

- **`upsertNode()`** -- Case-insensitive dedup by `(name, node_type)`
- **`findNodeByName()`** -- Case-insensitive exact match, optional type filter
- **`searchNodes()`** -- `LIKE '%query%'` on canonical name
- **`upsertEdge()`** -- Dedup by `(source_id, target_id, relation)`, increments weight
- **`getNodeEdges()`** -- All edges where node is source or target
- **`traverseGraph()`** -- Recursive CTE traversal up to `maxDepth` hops, handles cycles
- **`getRelatedMemoryIds()`** -- Distinct `memory_id` values from edges connected to given nodes
- **`getMemoryNodes()`** -- All graph nodes connected to a specific memory

## Context Building (`src/context.ts`)

- **`renderObservations(obs)`** -- Format observations with priority-based prefixes: `!` high, `-` medium, `~` low
- **`renderObservationsWithBudget(obs)`** -- Priority-based eviction when over token budget (default: 2000 tokens). Evicts low priority first, then medium.
- **`buildContextWindow()`** -- Full context assembly

Example output:

```
! [2024-01-15] User has a dentist appointment on March 5th at 9am
- [2024-01-15] User is working on a TypeScript project called Construct
~ [2024-01-14] User mentioned they had coffee this morning
```

## Embeddings (`src/embeddings.ts`)

- **`generateEmbedding(apiKey, text, model)`** -- OpenRouter embedding API call
- **`cosineSimilarity(a, b)`** -- Vector similarity for dedup and search

## Token Estimation (`src/tokens.ts`)

Uses a `chars / 4` heuristic, plus 4 tokens overhead per message. Intentionally simple, designed to be swappable.

## Database Layer (`src/db/`)

### Schema (`db/types.ts`)

`CairnDatabase` defines the base tables all consumers share:

| Table           | Purpose                                                    |
| --------------- | ---------------------------------------------------------- |
| `memories`      | Long-term facts, preferences, notes with FTS5 + embeddings |
| `memories_fts`  | FTS5 virtual table (synced via triggers)                   |
| `conversations` | Groups messages by source + external ID                    |
| `messages`      | Individual messages within conversations                   |
| `observations`  | Compressed conversation summaries                          |
| `graph_nodes`   | Entities extracted from memories                           |
| `graph_edges`   | Relationships between entities                             |
| `ai_usage`      | LLM token/cost tracking                                    |

Apps extend this schema with their own tables (e.g., Construct adds `schedules`, `settings`, `secrets`, `pending_asks`).

### Key Schema Details

**observations**:

| Column               | Type               | Notes                          |
| -------------------- | ------------------ | ------------------------------ |
| `id`                 | text (PK)          | nanoid                         |
| `conversation_id`    | text (FK)          | References conversations       |
| `content`            | text               | The observation text           |
| `priority`           | text               | `high`, `medium`, or `low`     |
| `observation_date`   | text               | Date context                   |
| `source_message_ids` | text (nullable)    | JSON array of message IDs      |
| `token_count`        | integer (nullable) | Estimated tokens               |
| `generation`         | integer            | 0 = observer, 1+ = reflector   |
| `superseded_at`      | text (nullable)    | Set when replaced by reflector |
| `promoted_at`        | text (nullable)    | Set when promoted to memory    |
| `created_at`         | text               | Auto-set                       |

**graph_nodes**: Unique on `(name, node_type)`. Canonical name is lowercased/trimmed. Types configurable via `entityTypes`.

**graph_edges**: Unique on `(source_id, target_id, relation)`. Weight incremented on repeated mention. Links back to source `memory_id`.

### Queries (`db/queries.ts`)

- **`storeMemory()`** -- Insert with nanoid, return full record
- **`recallMemories(query, opts)`** -- Hybrid search: FTS5 (with recency decay) + embedding cosine similarity (with recency decay) + LIKE fallback. Results merged and deduplicated.
- **`updateMemoryEmbedding()`** -- Store embedding as JSON
- **`forgetMemory()`** -- Soft-delete via `archived_at`
- **`trackUsage()`** -- Insert usage record

**Recency decay**: Both FTS5 and embedding results are scored with a decay function: `1.0 / (1.0 + Math.log2(ageInDays / 7))` for memories older than 7 days. This prevents stale results from dominating recall.

## Exports

```
@repo/cairn             # MemoryManager, types, observer, reflector, context, tokens,
                        # CairnMessage, DEFAULT_OBSERVER_PROMPT, DEFAULT_REFLECTOR_PROMPT,
                        # DEFAULT_ENTITY_TYPES, generateEmbedding, cosineSimilarity
@repo/cairn/graph       # processMemoryForGraph
@repo/cairn/graph/queries # searchNodes, traverseGraph, upsertNode, upsertEdge, etc.
@repo/cairn/db/types    # CairnDatabase, table types
@repo/cairn/db/queries  # storeMemory, recallMemories, etc.
```

## Key Files

| File                   | Role                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `src/index.ts`         | Barrel exports                                                |
| `src/manager.ts`       | MemoryManager class (main facade)                             |
| `src/observer.ts`      | Message -> observations LLM worker                            |
| `src/reflector.ts`     | Observation condenser LLM worker                              |
| `src/context.ts`       | Observation rendering with budget eviction                    |
| `src/embeddings.ts`    | OpenRouter embeddings + cosine similarity                     |
| `src/tokens.ts`        | Token estimation (char/4 heuristic)                           |
| `src/types.ts`         | All shared types (CairnMessage, Observation, GraphNode, etc.) |
| `src/db/types.ts`      | CairnDatabase schema type                                     |
| `src/db/queries.ts`    | Memory CRUD, FTS5 hybrid recall, usage tracking               |
| `src/graph/index.ts`   | processMemoryForGraph orchestrator                            |
| `src/graph/extract.ts` | LLM entity/relationship extraction                            |
| `src/graph/queries.ts` | Graph CRUD, search, traversal                                 |

## Consumers

- **Construct** -- Full pipeline. Subclasses MemoryManager as `ConstructMemoryManager` with custom prompts, `expires_at` support, and `telegram_message_id` handling.
- **Cortex** -- Price + news messages fed through observer -> promoter -> reflector. Analyzer uses recallMemories + graph traversal for signal generation.
- **Loom** -- Rulebook ingestion into memories + graph. Observer/reflector for campaign session context.
- **Deck** -- Read-only: queries memories, observations, graph for visualization.

## Architecture Decisions

- **Batched observer** -- Messages split into 16K token batches. Watermark advances per batch for crash safety.
- **Embedding-based dedup** -- Promoter compares observation embeddings against all existing memories. Prevents redundant accumulation.
- **Priority-based eviction** -- Low-priority observations evicted first when context budget exceeded.
- **Recency decay** -- Both FTS5 and embedding recall penalize stale results logarithmically.
- **Subclassable MemoryManager** -- Protected hooks let apps customize without forking the core pipeline.
- **Separate from Construct** -- Extracted as a shared package so Cortex, Loom, and future apps use the same pipeline.

## Token Thresholds

| Constant               | Value        | Purpose                                                 |
| ---------------------- | ------------ | ------------------------------------------------------- |
| `OBSERVER_THRESHOLD`   | 3000 tokens  | Min un-observed message tokens before observer triggers |
| `REFLECTOR_THRESHOLD`  | 4000 tokens  | Min active observation tokens before reflector triggers |
| `OBSERVER_BATCH_LIMIT` | 16000 tokens | Max tokens per observer batch                           |

## Configuration

| Variable              | Required | Default                   | Description                                                                                                     |
| --------------------- | -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `MEMORY_WORKER_MODEL` | No       | _(none)_                  | OpenRouter model for observer, reflector, graph extraction. If unset, LLM-powered memory features are disabled. |
| `EMBEDDING_MODEL`     | No       | `qwen/qwen3-embedding-4b` | OpenRouter model for embeddings.                                                                                |
| `OPENROUTER_API_KEY`  | Yes      | --                        | Used for all API calls.                                                                                         |
