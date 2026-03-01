```
 ██████╗ █████╗ ██╗██████╗ ███╗   ██╗
██╔════╝██╔══██╗██║██╔══██╗████╗  ██║
██║     ███████║██║██████╔╝██╔██╗ ██║
██║     ██╔══██║██║██╔══██╗██║╚██╗██║
╚██████╗██║  ██║██║██║  ██║██║ ╚████║
 ╚═════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝
```

> *A cairn marks where something important happened. A pile of stones in the wilderness, left by someone who passed through before you.*

---

**Cairn** is the memory substrate -- the shared library that turns raw conversation into persistent, structured knowledge. It observes, reflects, promotes, graphs, and recalls. Every memory in the system passes through cairn at some point.

It solves the oldest problem in long-running AI conversations: context windows are finite, but memory shouldn't be.

## The Pipeline

```
  raw messages
       │
       ▼
╔══════════════╗     threshold: 3,000 tokens
║   OBSERVER   ║     compress messages → atomic facts
║  (gen 0)     ║     priority: low | medium | high
╚══════╤═══════╝     temporal anchoring (YYYY-MM-DD)
       │
       ▼
╔══════════════╗     threshold: 4,000 tokens
║  REFLECTOR   ║     merge overlapping observations
║  (gen 1+)    ║     supersede old facts, increment generation
╚══════╤═══════╝     drop noise, keep corrections
       │
       ▼ promoteObservations()
       │              embedding similarity > 0.85 = duplicate
       │              novel observations → persistent memories
       │
       ▼
╔══════════════╗     LLM extraction → entities + relationships
║    GRAPH     ║     canonical node names (lowercase dedup)
║              ║     weighted edges, recursive CTE traversal
╚══════════════╝
```

Two named stages (Observer, Reflector), then promotion and graph extraction -- both methods on the MemoryManager, not standalone actors. Each fires independently. Watermark-based, failure-safe, non-blocking.

## Observer

Watches un-observed messages. When they exceed 3,000 tokens, it compresses them into atomic facts.

- User statements are **authoritative** -- not hedged, not softened
- One fact per observation. Frame state changes explicitly ("switched from X to Y")
- Preserve distinguishing attributes. No pleasantries, no meta-discussion
- Batched into chunks of 16,000 tokens max. Each batch advances its own watermark

## Reflector

When active observations exceed 4,000 tokens, the reflector merges overlapping facts into richer, self-contained observations. Old facts get `superseded_at` timestamps. Generation counter increments.

Merge topical overlaps. Don't merge unrelated facts. Prefer specifics over generalities. Drop low-priority noise unless it's a correction.

## Promotion

Not a stage -- a method. `promoteObservations()` queries unpromoted medium/high-priority observations, generates embeddings, and compares against all existing memories at 0.85 cosine similarity. Novel observations become permanent memories. Duplicates are skipped. Graph extraction fires async for each promoted memory. All candidates get marked `promoted_at` regardless of outcome.

## Graph

Extracts entities and relationships from memories. Entities are typed (person, place, concept, event, entity) with canonical lowercase names for dedup. Edges are directed, weighted (incremented on repeated mention), and linked back to source memories.

Queries support hybrid search (LIKE + embedding similarity), recursive CTE traversal to arbitrary depth, and memory-to-node linkage.

## Recall

Three search modes, wired together:

| Mode | Engine | Use |
|---|---|---|
| **FTS** | SQLite FTS5 | Keyword search, fast |
| **Embedding** | Cosine similarity | Semantic search, slower |
| **Graph** | Node traversal + linked memories | Relational context |

## The Memory Manager

Single entry point. Wraps the full pipeline.

```typescript
import { MemoryManager } from '@repo/cairn'

const memory = new MemoryManager(db, {
  workerConfig,     // LLM config for observer/reflector
  embeddingModel,   // default: qwen/qwen3-embedding-4b
  apiKey,           // OpenRouter key
  logger,           // optional
})

// observe → reflect → promote → graph
await memory.runObserver(conversationId)
await memory.runReflector(conversationId)
await memory.promoteObservations(conversationId)

// recall
const context = await memory.buildContext(conversationId)
```

## Exports

```typescript
import { MemoryManager } from '@repo/cairn'
import { generateEmbedding, cosineSimilarity } from '@repo/cairn/embeddings'
import { processMemoryForGraph } from '@repo/cairn/graph'
import { searchNodes, traverseGraph, getNodeEdges, getRelatedMemoryIds } from '@repo/cairn/graph/queries'
import { recallMemories, storeMemory, getRecentMemories } from '@repo/cairn/db/queries'
```

## Thresholds

| Constant | Value | Purpose |
|---|---|---|
| `OBSERVER_THRESHOLD` | 3,000 tokens | Trigger message compression |
| `REFLECTOR_THRESHOLD` | 4,000 tokens | Trigger observation condensation |
| `OBSERVER_MAX_BATCH_TOKENS` | 16,000 tokens | Max per observer batch |
| `OBSERVATION_BUDGET` | 8,000 tokens | Context injection ceiling |
| Promotion similarity | 0.85 | Dedup threshold for new memories |
| Node search threshold | 0.3 | Embedding match for graph nodes |

---

> *Stones stacked in the dark. Each one a fact. Each one placed deliberately, so the next traveler knows what came before.*

Cairn remembers the shape of what was said.
