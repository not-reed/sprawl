# @repo/cairn

Memory substrate shared by Construct, Cortex, and Deck. Provides observation, reflection, promotion, graph extraction, embedding search, and FTS5 full-text search.

## Key Files

- `src/manager.ts` -- `MemoryManager` class: facade for the full pipeline
- `src/observer.ts` -- `observe()`: compresses messages into observations via LLM
- `src/reflector.ts` -- `reflect()`: condenses observations when token budget exceeded
- `src/context.ts` -- `renderObservations()`, `buildContextWindow()`: priority-based budget eviction
- `src/embeddings.ts` -- `generateEmbedding()`, `cosineSimilarity()` via OpenRouter
- `src/graph/index.ts` -- `processMemoryForGraph()`: orchestrates entity/relationship extraction
- `src/graph/extract.ts` -- `extractEntities()` via LLM
- `src/graph/queries.ts` -- `searchNodes`, `traverseGraph`, `upsertNode`, `upsertEdge`
- `src/db/queries.ts` -- `storeMemory`, `recallMemories`, `trackUsage`, `updateMemoryEmbedding`
- `src/db/types.ts` -- `CairnDatabase` schema (memories, observations, graph_nodes, graph_edges, etc.)
- `src/index.ts` -- Barrel exports (this is the public API)
- `src/errors.ts` -- `MemoryError`, `EmbeddingError`, `GraphError`

## Architecture

```
MemoryManager (manager.ts)
  ├── observe()    -- messages → observations (LLM compression, batched)
  ├── reflect()    -- observations → condensed observations (when budget exceeded)
  ├── promote()    -- observations → long-term memories (embedding-deduped)
  └── processMemoryForGraph() -- memory → graph nodes + edges (LLM extraction)

Memory Recall (db/queries.ts)
  ├── FTS5 full-text search (memories_fts)
  ├── Embedding similarity (cosine)
  └── Graph traversal (searchNodes → traverseGraph → getRelatedMemoryIds)
```

Key thresholds in `manager.ts`:

- `OBSERVER_THRESHOLD = 3000` tokens -- triggers observation
- `REFLECTOR_THRESHOLD = 4000` tokens -- triggers reflection
- `OBSERVER_MAX_BATCH_TOKENS = 16_000` -- max batch size for observer LLM calls

## Subclassing MemoryManager

Consumers (Construct, Cortex) subclass `MemoryManager` to customize:

- `storeObservation()` -- override to add custom fields (e.g. `telegram_message_id`)
- Constructor options: `observerPrompt`, `reflectorPrompt`, `entityTypes`

## Testing

```bash
just test-cairn
```

- **Test DB**: `src/__tests__/test-db.ts` -- `setupCairnTestDb()` creates in-memory SQLite with all cairn tables (memories, conversations, messages, ai_usage, graph_nodes, graph_edges, observations). Use this for any test touching cairn queries directly.
- **Fixtures**: `src/__tests__/fixtures.ts`
  - `createTestObservation()`, `createTestMemory()`, `createTestNewMemory()`
  - `createTestGraphNode()`, `createTestGraphEdge()`
  - `createTestMessage()`, `createTestNewObservation()`

## Common Tasks

### Adding a Query Function

1. Add to `src/db/queries.ts`
2. Export from `src/index.ts`
3. Add test using `setupCairnTestDb()`

### Adding a Graph Query

1. Add to `src/graph/queries.ts`
2. Export from `src/index.ts`

### Modifying CairnDatabase Schema

Cairn doesn't own migrations -- each consumer app (construct, cortex) has its own migration files. The `CairnDatabase` type in `src/db/types.ts` defines the expected schema shape. When changing:

1. Update types in `src/db/types.ts`
2. Update `setupCairnTestDb()` in `src/__tests__/test-db.ts` to match
3. Add migrations in each consumer app that uses the new columns

### Adding an Entity Type for Graph Extraction

Default types are in `src/graph/extract.ts` (`DEFAULT_ENTITY_TYPES`). Consumers can override via `entityTypes` option in `MemoryManager` constructor.
