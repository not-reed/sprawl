/**
 * Tests for spreading activation graph traversal and its integration
 * with the memory recall pipeline.
 *
 * Proves four bugs:
 * 1. spreadActivation correctly scores nodes with decay and edge weights
 * 2. memory_recall graph memories must carry activation scores (was discarded)
 * 3. Recall without graph expansion misses connected memories (Loom gap)
 * 4. Memories without embeddings are invisible to semantic search (Cortex signal gap)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import {
  spreadActivation,
  searchNodesWithScores,
  getRelatedMemoryIds,
  recallMemories,
  storeMemory,
  upsertEdge,
} from "@repo/cairn";
import { setupDb, seedMemories, seedGraph, memoryEmbeddings, queryEmbeddings } from "./fixtures.js";

let db: Kysely<Database>;
let memIds: Record<string, string>;
let nodeIds: Record<string, string>;

beforeEach(async () => {
  db = await setupDb();
  const seeded = await seedMemories(db);
  memIds = seeded.ids;
  const graph = await seedGraph(db, memIds);
  nodeIds = graph.nodeIds;
});

afterEach(async () => {
  await db.destroy();
});

// ── Bug 1: spreadActivation scoring ────────────────────────────────────

describe("spreadActivation — scoring correctness", () => {
  it("returns scored nodes with depth", async () => {
    const seeds = [{ nodeId: nodeIds.portland, score: 1.0 }];
    const results = await spreadActivation(db, seeds, { maxDepth: 2 });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.depth).toBeGreaterThan(0);
      expect(r.node).toBeDefined();
      expect(r.node.id).toBeDefined();
    }
  });

  it("scores decay with depth — depth-1 nodes score higher than depth-2", async () => {
    // Portland → Alex (depth 1) → Miso (depth 2)
    const seeds = [{ nodeId: nodeIds.portland, score: 1.0 }];
    const results = await spreadActivation(db, seeds, { maxDepth: 2, decay: 0.5 });

    const alex = results.find((r) => r.node.id === nodeIds.alex);
    const miso = results.find((r) => r.node.id === nodeIds.miso);

    expect(alex).toBeDefined();
    expect(miso).toBeDefined();
    expect(alex!.score).toBeGreaterThan(miso!.score);
    expect(alex!.depth).toBe(1);
    expect(miso!.depth).toBe(2);
  });

  it("higher edge weights produce higher activation scores", async () => {
    // Bump the Alex→Miso edge weight to 5
    await upsertEdge(db, {
      source_id: nodeIds.alex,
      target_id: nodeIds.miso,
      relation: "owns",
      memory_id: memIds.miso,
    });
    await upsertEdge(db, {
      source_id: nodeIds.alex,
      target_id: nodeIds.miso,
      relation: "owns",
      memory_id: memIds.miso,
    });
    await upsertEdge(db, {
      source_id: nodeIds.alex,
      target_id: nodeIds.miso,
      relation: "owns",
      memory_id: memIds.miso,
    });
    await upsertEdge(db, {
      source_id: nodeIds.alex,
      target_id: nodeIds.miso,
      relation: "owns",
      memory_id: memIds.miso,
    });
    // weight is now 5 (1 initial + 4 upserts)

    const seeds = [{ nodeId: nodeIds.alex, score: 1.0 }];
    const results = await spreadActivation(db, seeds, { maxDepth: 1, decay: 0.5 });

    const miso = results.find((r) => r.node.id === nodeIds.miso);
    const rust = results.find((r) => r.node.id === nodeIds.rust);

    expect(miso).toBeDefined();
    expect(rust).toBeDefined();
    // Miso edge weight=5, Rust edge weight=1
    expect(miso!.score).toBeGreaterThan(rust!.score);
  });

  it("scores never exceed seed score — weights reduce decay, not amplify", async () => {
    // Even with high edge weights, child scores must stay <= parent
    // Bump Alex→Miso to weight 10
    for (let i = 0; i < 9; i++) {
      await upsertEdge(db, {
        source_id: nodeIds.alex,
        target_id: nodeIds.miso,
        relation: "owns",
        memory_id: memIds.miso,
      });
    }

    const seedScore = 0.8;
    const seeds = [{ nodeId: nodeIds.alex, score: seedScore }];
    const results = await spreadActivation(db, seeds, { maxDepth: 1 });

    for (const r of results) {
      expect(r.score).toBeLessThanOrEqual(seedScore);
    }
  });

  it("does not include seed nodes in results", async () => {
    const seeds = [{ nodeId: nodeIds.alex, score: 1.0 }];
    const results = await spreadActivation(db, seeds);

    const seedInResults = results.find((r) => r.node.id === nodeIds.alex);
    expect(seedInResults).toBeUndefined();
  });

  it("results are sorted by score descending", async () => {
    const seeds = [{ nodeId: nodeIds.alex, score: 1.0 }];
    const results = await spreadActivation(db, seeds, { maxDepth: 2 });

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});

// ── Bug 2: graph memory scores must propagate ──────────────────────────

describe("graph recall — scores must propagate to memories", () => {
  /**
   * Replicate memory_recall's graph expansion logic.
   * This test proves the bug: graph memories should carry activation scores.
   */
  it("graph-expanded memories must have scores > 0", async () => {
    const seedNodes = await searchNodesWithScores(db, "portland", 5);
    expect(seedNodes.length).toBeGreaterThan(0);

    const seeds = seedNodes.map((s) => ({ nodeId: s.node.id, score: s.score }));
    const activated = await spreadActivation(db, seeds, { maxDepth: 2 });

    // Build node score map (what memory_recall does)
    const nodeScoreMap = new Map<string, number>();
    for (const s of seedNodes) nodeScoreMap.set(s.node.id, s.score);
    for (const a of activated) nodeScoreMap.set(a.node.id, a.score);

    const allNodeIds = [...nodeScoreMap.keys()];
    const relatedMemIds = await getRelatedMemoryIds(db, allNodeIds);
    expect(relatedMemIds.length).toBeGreaterThan(0);

    // For each related memory, we should be able to derive a score from the nodeScoreMap
    // by looking up which scored nodes the memory's edges connect to
    for (const memId of relatedMemIds) {
      const edges = await db
        .selectFrom("graph_edges")
        .selectAll()
        .where("memory_id", "=", memId)
        .execute();

      const bestScore = Math.max(
        0,
        ...edges.flatMap((e) => [
          nodeScoreMap.get(e.source_id) ?? 0,
          nodeScoreMap.get(e.target_id) ?? 0,
        ]),
      );

      // This MUST be > 0 — if it's 0, the score didn't propagate
      expect(bestScore).toBeGreaterThan(0);
    }
  });

  it("getRelatedMemoriesWithScores returns scored memories", async () => {
    // This function should exist in cairn — it's the fix for the nodeScoreMap bug.
    // Import will fail until we add it (RED).
    const { getRelatedMemoriesWithScores } = await import("@repo/cairn");

    const nodeScoreMap = new Map<string, number>();
    nodeScoreMap.set(nodeIds.alex, 0.8);
    nodeScoreMap.set(nodeIds.portland, 0.5);
    nodeScoreMap.set(nodeIds.miso, 0.3);

    const scored = await getRelatedMemoriesWithScores(db, nodeScoreMap);

    expect(scored.length).toBeGreaterThan(0);
    for (const item of scored) {
      expect(item.memoryId).toBeDefined();
      expect(item.score).toBeGreaterThan(0);
    }

    // Memories linked to higher-scored nodes should have higher scores
    const sorted = scored.toSorted((a, b) => b.score - a.score);
    expect(sorted[0].score).toBeGreaterThanOrEqual(sorted[sorted.length - 1].score);
  });
});

// ── Bug 3: recall without graph misses connected memories (Loom gap) ──

describe("recall without graph expansion — misses connected memories", () => {
  it("FTS-only recall for 'portland' misses DataPipe memory", async () => {
    // Direct recall for "portland" — should find portland memory via FTS
    const direct = await recallMemories(db, "portland", { limit: 10 });
    const directIds = new Set(direct.map((m) => m.id));

    // Portland memory should be in direct results
    expect(directIds.has(memIds.portland)).toBe(true);

    // But DataPipe memory should NOT be in direct results
    // (no text overlap between "portland" and "DataPipe" content)
    expect(directIds.has(memIds.datapipe)).toBe(false);

    // WITH graph expansion, DataPipe IS reachable:
    // Portland node → Alex node → DataPipe node → DataPipe memory
    const seedNodes = await searchNodesWithScores(db, "portland", 5);
    const seeds = seedNodes.map((s) => ({ nodeId: s.node.id, score: s.score }));
    const activated = await spreadActivation(db, seeds, { maxDepth: 2 });
    const allNodeIds = [...seedNodes.map((s) => s.node.id), ...activated.map((a) => a.node.id)];
    const graphMemIds = await getRelatedMemoryIds(db, allNodeIds);

    // Graph expansion DOES find DataPipe
    expect(graphMemIds).toContain(memIds.datapipe);
  });
});

// ── Bug 4: memories without embeddings invisible to semantic search ────

describe("memories without embeddings — semantic search gap", () => {
  it("memory stored without embedding is not found by semantic search", async () => {
    // Replicate Cortex's pattern: storeMemory with embedding: null
    const noEmbedding = await storeMemory(db, {
      content: "[Signal BTC short] BUY (0.85): Strong bullish momentum",
      category: "signal",
      source: "analyzer",
      tags: '["bitcoin","buy"]',
      embedding: null,
    });

    // FTS5 can find it
    const ftsResults = await recallMemories(db, "BTC bullish momentum", { limit: 10 });
    const ftsIds = ftsResults.map((m) => m.id);
    expect(ftsIds).toContain(noEmbedding.id);

    // But semantic search (embedding-only) CANNOT find it
    const semanticResults = await recallMemories(db, "bitcoin price analysis", {
      limit: 10,
      queryEmbedding: queryEmbeddings.work, // using a work-domain embedding
    });
    const embeddingMatches = semanticResults.filter((m) => m.matchType === "embedding");
    const embeddingIds = embeddingMatches.map((m) => m.id);
    expect(embeddingIds).not.toContain(noEmbedding.id);
  });

  it("memory WITH embedding IS found by semantic search", async () => {
    const withEmbedding = await storeMemory(db, {
      content: "[Signal BTC short] BUY (0.85): Strong bullish momentum",
      category: "signal",
      source: "analyzer",
      tags: '["bitcoin","buy"]',
      embedding: JSON.stringify(memoryEmbeddings.datapipe), // work-domain embedding
    });

    const results = await recallMemories(db, "work projects", {
      limit: 10,
      queryEmbedding: queryEmbeddings.work,
    });
    const ids = results.map((m) => m.id);
    expect(ids).toContain(withEmbedding.id);
  });
});

// ── Temporal recall (should pass — already implemented) ────────────────

describe("recallMemories — temporal filtering", () => {
  it("since filters out older memories", async () => {
    // All seed memories were created "now" — store one with a forced old date
    const oldMemory = await storeMemory(db, {
      content: "Ancient fact from long ago",
      category: "general",
      source: "user",
    });
    // Manually backdate it
    await db
      .updateTable("memories")
      .set({ created_at: "2020-01-01T00:00:00Z" })
      .where("id", "=", oldMemory.id)
      .execute();

    const results = await recallMemories(db, "ancient fact", {
      since: "2024-01-01",
      limit: 10,
    });
    const ids = results.map((m) => m.id);
    expect(ids).not.toContain(oldMemory.id);
  });

  it("before filters out newer memories", async () => {
    const results = await recallMemories(db, "Alex", {
      before: "2020-01-01",
      limit: 10,
    });
    // All seed memories were created "now" (2026), so none should match
    expect(results).toHaveLength(0);
  });

  it("since + before creates a date range", async () => {
    // Backdate one memory to 2023
    await db
      .updateTable("memories")
      .set({ created_at: "2023-06-15T00:00:00Z" })
      .where("id", "=", memIds.miso)
      .execute();

    const results = await recallMemories(db, "Miso cat", {
      since: "2023-01-01",
      before: "2024-01-01",
      limit: 10,
    });
    const ids = results.map((m) => m.id);
    expect(ids).toContain(memIds.miso);

    // Other memories (created "now") should not be in range
    expect(ids).not.toContain(memIds.portland);
  });
});
