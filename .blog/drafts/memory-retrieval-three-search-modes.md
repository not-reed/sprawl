---
title: "Three Ways to Find a Memory: FTS5, Embeddings, and Graph Traversal in a Personal AI"
date: 2026-02-26
tags: [memory, fts5, embeddings, knowledge-graph, retrieval]
description: "How Construct combines FTS5, vector embeddings, and graph traversal to find the right memory at the right time."
---

# Three Ways to Find a Memory: FTS5, Embeddings, and Graph Traversal in a Personal AI

There are two kinds of forgetting in AI companions. The obvious kind: the context window fills up and older messages get truncated. The subtle kind: you've stored a memory, but when the user asks a related question, the retrieval system hands back the wrong things, or nothing.

The previous article in this series covered how Construct compresses conversations into observations. This article covers retrieval: how the agent finds relevant memories when it needs them.

It's more layered than you'd think.

## Two Modes of Retrieval

The code treats passive retrieval and active retrieval very differently.

**Passive retrieval** happens automatically on every message. Before the agent even sees the user's input, the `processMessage` pipeline runs two database queries and injects the results into the context preamble:

```typescript
// src/agent.ts
const recentMemories = await getRecentMemories(db, 10)

let queryEmbedding: number[] | undefined
let relevantMemories = []
try {
  queryEmbedding = await generateEmbedding(env.OPENROUTER_API_KEY, message, env.EMBEDDING_MODEL)
  const results = await recallMemories(db, message, {
    limit: 5,
    queryEmbedding,
    similarityThreshold: 0.4,
  })
  const recentIds = new Set(recentMemories.map((m) => m.id))
  relevantMemories = results
    .filter((m) => !recentIds.has(m.id))
    .map((m) => ({ content: m.content, category: m.category, score: m.score }))
} catch {
  // Embedding call failed, no relevant memories, that's fine
}
```

These memories get injected via the context preamble (not the system prompt, more on that architectural choice below):

```typescript
// src/system-prompt.ts
if (context.recentMemories && context.recentMemories.length > 0) {
  preamble += '\n[Recent memories: use these for context, pattern recognition, and continuity]\n'
  for (const m of context.recentMemories) {
    preamble += `- (${m.category}) ${m.content}\n`
  }
}

if (context.relevantMemories && context.relevantMemories.length > 0) {
  preamble += '\n[Potentially relevant memories]\n'
  for (const m of context.relevantMemories) {
    const score = m.score !== undefined ? ` (${(m.score * 100).toFixed(0)}% match)` : ''
    preamble += `- (${m.category}) ${m.content}${score}\n`
  }
}
```

The agent doesn't need to invoke any tool for this. It just arrives already knowing recent history and whatever is semantically relevant to the current message.

**Active retrieval** happens when the agent decides it needs to dig deeper. The `memory_recall` tool lets the agent search explicitly by keyword or topic. This is where the full retrieval stack comes into play.

## The FTS5 → Embedding Waterfall

The `recallMemories` function in `src/db/queries.ts` runs two passes in sequence, merging and deduplicating results as it goes:

```typescript
/**
 * Hybrid memory recall: FTS5 → embeddings.
 * Results are merged and deduplicated by memory ID.
 */
export async function recallMemories(
  db: DB,
  query: string,
  opts?: {
    category?: string
    limit?: number
    queryEmbedding?: number[]
    similarityThreshold?: number
  },
): Promise<(Memory & { score?: number; matchType?: string })[]> {
  const limit = opts?.limit ?? 10
  const seen = new Set<string>()
  const results: (Memory & { score?: number; matchType?: string })[] = []

  // 1. FTS5 full-text search
  // 2. Embedding cosine similarity
}
```

**Pass 1: FTS5.** SQLite's FTS5 virtual table provides BM25-ranked full-text search over memory content and tags. The query tokenizer is minimal: it splits on whitespace, quotes each token, and joins with OR:

```typescript
const ftsQuery = query
  .split(/\s+/)
  .filter((w) => w.length > 1)
  .map((w) => `"${w.replace(/"/g, '')}"`)
  .filter((w) => w !== '""')
  .join(' OR ')

if (ftsQuery) {
  const ftsResults = await sql<Memory & { rank: number }>`
    SELECT m.*, fts.rank
    FROM memories_fts fts
    JOIN memories m ON m.id = fts.id
    WHERE memories_fts MATCH ${ftsQuery}
      AND m.archived_at IS NULL
    ORDER BY fts.rank
    LIMIT ${limit}
  `.execute(db)

  for (const row of ftsResults.rows) {
    if (!seen.has(row.id)) {
      seen.add(row.id)
      results.push({ ...row, matchType: 'fts5' })
    }
  }
}
```

FTS5 is fast, runs entirely in SQLite with no external dependencies, and handles stemming and ranking well for short queries. The `memories_fts` virtual table is kept synchronized via three database triggers created in migration 002: an AFTER INSERT, AFTER DELETE, and AFTER UPDATE that maintain the FTS index in lockstep with the main `memories` table.

**Pass 2: Embedding similarity.** If FTS5 found fewer results than the limit, the embedding pass runs. It fetches all memories with stored embeddings, computes cosine similarity in-process, filters by threshold, and promotes the best matches:

```typescript
if (opts?.queryEmbedding && results.length < limit) {
  const threshold = opts.similarityThreshold ?? 0.3
  const allWithEmbeddings = await db
    .selectFrom('memories')
    .selectAll()
    .where('archived_at', 'is', null)
    .where('embedding', 'is not', null)
    .execute()

  const scored = allWithEmbeddings
    .map((m) => ({
      ...m,
      score: cosineSimilarity(opts.queryEmbedding!, JSON.parse(m.embedding!)),
      matchType: 'embedding' as const,
    }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score)

  for (const m of scored) {
    if (!seen.has(m.id) && results.length < limit) {
      seen.add(m.id)
      results.push(m)
    }
  }
}
```

The cosine similarity is a straightforward implementation with no SIMD optimizations:

```typescript
// src/embeddings.ts
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0
  return dotProduct / denominator
}
```

Embeddings are generated via OpenRouter using `qwen/qwen3-embedding-4b` (configurable via `EMBEDDING_MODEL` env var) and stored as JSON-serialized float arrays in a `TEXT` column. The embedding is generated asynchronously and stored after the memory is saved, so for the first few milliseconds after storing a memory, it's not yet semantically searchable. That's an acceptable tradeoff for a personal AI where memories accumulate slowly.

## The Graph Expansion Layer

Active memory recall goes one step further. After the FTS5/embedding waterfall, `memory_recall` performs a graph expansion pass using the knowledge graph:

```typescript
// src/tools/core/memory-recall.ts
const seen = new Set(memories.map((m) => m.id))
const graphNodes = await searchNodes(db, args.query, 5, queryEmbedding)

if (graphNodes.length > 0) {
  // Traverse 1-2 hops from matching nodes
  const allNodeIds = new Set<string>()
  for (const node of graphNodes) {
    allNodeIds.add(node.id)
    const traversed = await traverseGraph(db, node.id, 2)
    for (const t of traversed) {
      allNodeIds.add(t.node.id)
    }
  }

  // Find memories linked to these nodes
  const relatedMemIds = await getRelatedMemoryIds(db, [...allNodeIds])
  const newMemIds = relatedMemIds.filter((id) => !seen.has(id))

  if (newMemIds.length > 0) {
    const relatedMems = await db
      .selectFrom('memories')
      .selectAll()
      .where('id', 'in', newMemIds)
      .where('archived_at', 'is', null)
      .limit(5)
      .execute()

    graphMemories = relatedMems.map((m) => ({ ...m, matchType: 'graph' }))
  }
}
```

The graph traversal uses a recursive CTE that walks edges bidirectionally:

```sql
WITH RECURSIVE traverse(node_id, depth, via_relation, visited) AS (
  SELECT ${startNodeId}, 0, NULL, ${startNodeId}
  UNION ALL
  SELECT
    CASE
      WHEN e.source_id = t.node_id THEN e.target_id
      ELSE e.source_id
    END,
    t.depth + 1,
    e.relation,
    t.visited || ',' || ...
  FROM traverse t
  JOIN graph_edges e ON (e.source_id = t.node_id OR e.target_id = t.node_id)
  WHERE t.depth < ${maxDepth}
    AND t.visited NOT LIKE '%' || ... || '%'
)
```

The cycle prevention is done by tracking visited node IDs in a comma-delimited string that gets passed down through the recursion, a SQLite-native approach since there's no array type. It's not elegant, but it works.

What this enables: suppose the agent stored a memory "Alice introduced me to the restaurant Nightshade." When the user later asks "do I know any good restaurants?", the text search might not connect "restaurant" to "Nightshade" if those words don't co-occur in the memory. But the graph has edges like `Alice -> [introduced to] -> Nightshade` and `Nightshade -> [is a] -> restaurant`. The graph expansion traverses those edges and surfaces the Nightshade memory even without a keyword match.

Graph expansion results are tagged with `matchType: 'graph'` so the agent knows these are indirect associations rather than direct matches.

## Why the Preamble, Not the System Prompt

One architectural decision worth explaining. The injected memories don't go into the system prompt. They go into the context preamble, which is prepended to the user's first message:

```typescript
// src/agent.ts
await agent.prompt(preamble + message)
```

This is intentional. The system prompt is kept static, the same text for every conversation turn, which makes it eligible for prompt caching by the LLM provider. The dynamic per-request context (current time, memories, observations, skills) goes in the user message, where it's expected to vary.

The tradeoff: the memories arrive as a user-turn text block rather than authoritative system context. The agent has to treat injected memories as "here's what I know" rather than "here's ground truth." In practice this works fine. The model is instructed in the system prompt to use recent memories for context and pattern recognition, and the format makes the provenance clear.

## What It Looks Like to the Agent

For every message, the agent receives something like this prepended to the user's input:

```
[Context: Thursday, February 26, 2026 at 2:15 PM (America/New_York) | telegram]

[Recent memories: use these for context, pattern recognition, and continuity]
- (preference) User prefers dark-roast coffee in the morning
- (fact) User's partner is named Jordan
- (note) User is learning Portuguese via Duolingo

[Potentially relevant memories]
- (fact) User visited Lisbon in 2023 (78% match)
- (preference) User enjoys fado music (61% match)
```

If the agent then invokes `memory_recall` for more depth, the results come back annotated:

```
Found 5 memories:
[abc123] (fact) User visited Lisbon in 2023 | tags: travel, portugal [fts5]
[def456] (preference) User enjoys fado music [embedding] (71%)
[ghi789] (fact) User met a Portuguese speaker at work last month [graph]
```

The distinction between `fts5`, `embedding`, and `graph` matches gives the agent signal about how confident to be in each result's relevance.

## Tradeoffs

**The embedding scan is O(n).** The current implementation fetches all memories with embeddings and computes similarity in a JavaScript loop. For a personal AI with hundreds of memories this is fine, probably milliseconds. At thousands of memories it starts to matter. A production system would use a proper vector index (sqlite-vec, pgvector, etc.). The implementation only runs the embedding pass when `queryEmbedding` is present and there's still room in the result set, so it degrades gracefully if embeddings aren't configured.

**FTS5 and embeddings can disagree.** A query like "gym routine" might get a strong FTS5 hit on "I started a new gym routine" but a stronger embedding match on "I've been doing weights three times a week." The waterfall takes FTS5 results first, then fills the remaining slots with embedding results. There's no cross-rank fusion; FTS5 results are given priority by position in the waterfall. Reciprocal Rank Fusion or similar would be a more principled approach, but adds implementation complexity for a personal AI where the user can always ask again.

**Graph node search uses both embeddings and LIKE.** The graph expansion's `searchNodes` runs a LIKE match on node names and, when a query embedding is available, computes cosine similarity against node embeddings. Embedding matches go first, then LIKE results fill remaining slots, deduplicated:

```typescript
// src/memory/graph/queries.ts
export async function searchNodes(db, query, limit = 10, queryEmbedding?) {
  const pattern = `%${query.toLowerCase().trim()}%`
  const likeResults = await db
    .selectFrom('graph_nodes').selectAll()
    .where('name', 'like', pattern)
    .orderBy('updated_at', 'desc').limit(limit).execute()

  if (!queryEmbedding) return likeResults

  const allWithEmbeddings = await db
    .selectFrom('graph_nodes').selectAll()
    .where('embedding', 'is not', null).execute()

  const embeddingMatches = allWithEmbeddings
    .map((n) => ({ ...n, score: cosineSimilarity(queryEmbedding, JSON.parse(n.embedding!)) }))
    .filter((n) => n.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  // Merge: embedding matches first, then LIKE, deduplicated
  const seen = new Set<string>()
  const merged = []
  for (const node of [...embeddingMatches, ...likeResults]) {
    if (!seen.has(node.id) && merged.length < limit) {
      seen.add(node.id)
      merged.push(node)
    }
  }
  return merged
}
```

This LIKE search is over graph nodes (entities like people, places, concepts), not memories themselves. It's the entry point into the graph: find the relevant nodes, then traverse the edge structure to surface connected memories. Node embeddings are generated during graph extraction after upserting each entity, from a string like `"{name}: {description}"`. This runs in parallel via `Promise.allSettled` so a single failed API call doesn't break the extraction pipeline.

The result: if the user asks about "my dentist" and the graph has a node named "dr. martinez" with description "Reed's dentist," the embedding similarity catches the semantic connection that a LIKE match on the name alone would miss. The same `queryEmbedding` generated for memory retrieval gets reused here, so there's no extra API call.

## Summary

Most memory systems for LLM applications choose one retrieval strategy and call it done. FTS if you want something simple. Vector search if you want semantic matching. Graph traversal if you're feeling ambitious. Construct uses all three in a layered pipeline, not out of complexity for its own sake, but because each covers gaps the others leave.

FTS5 is fast and reliable for exact keyword matches. Embeddings catch semantic associations that don't share vocabulary. Graph traversal finds memories connected by relationship chains that neither keyword nor embedding search would surface. Each result carries its `matchType` (`'fts5'`, `'embedding'`, or `'graph'`), so the agent (and anyone debugging the system) can understand both what was retrieved and why.

The `queryEmbedding` generated for memory retrieval gets reused in three places: memory similarity search, graph node search, and tool pack selection. One API call, multiple consumers.
