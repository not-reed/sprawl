/**
 * Pipeline tests for write operations and their downstream impact on retrieval.
 *
 * Verifies that data written via storeMemory, updateMemoryEmbedding,
 * upsertNode, upsertEdge is correctly queryable via FTS5, embedding
 * cosine search, and graph traversal.
 *
 * The retrieval tests (recall-pipeline, graph-recall) prove recall works
 * given correct data. These tests prove the write path *produces* correct data.
 *
 * No API key needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import {
  storeMemory,
  updateMemoryEmbedding,
  recallMemories,
  forgetMemory,
  upsertNode,
  upsertEdge,
  findNodeByName,
  searchNodes,
  traverseGraph,
  getRelatedMemoryIds,
  getNodeEdges,
} from "@repo/cairn";
import { setupDb, memoryEmbeddings, queryEmbeddings } from "./fixtures.js";

let db: Kysely<Database>;

beforeEach(async () => {
  db = await setupDb();
});

afterEach(async () => {
  await db.destroy();
});

// ── Memory → FTS5 write consistency ─────────────────────────────────

describe("memory writes → FTS5 sync", () => {
  it("storeMemory makes content searchable via FTS5", async () => {
    await storeMemory(db, {
      content: "Alex is allergic to shellfish",
      category: "health",
      source: "user",
    });

    const results = await recallMemories(db, "shellfish");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchType).toBe("fts5");
    expect(results[0].content).toContain("shellfish");
  });

  it("storeMemory makes tags searchable via FTS5", async () => {
    await storeMemory(db, {
      content: "Some memory about health",
      category: "health",
      tags: "epipen,medical,allergy",
      source: "user",
    });

    // Search by tag keyword, not in content
    const results = await recallMemories(db, "epipen");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tags).toContain("epipen");
  });

  it("archived memory excluded from FTS5 recall", async () => {
    const mem = await storeMemory(db, {
      content: "Alex has a unique pet iguana named Spike",
      category: "personal",
      source: "user",
    });

    // Findable before archiving
    let results = await recallMemories(db, "iguana");
    expect(results.length).toBeGreaterThan(0);

    await forgetMemory(db, mem.id);

    // Not findable after archiving
    results = await recallMemories(db, "iguana");
    expect(results).toHaveLength(0);
  });

  it("multiple memories with overlapping keywords all appear in FTS5", async () => {
    await storeMemory(db, { content: "Alex likes Python for scripting", source: "user" });
    await storeMemory(db, { content: "Alex prefers Python over Ruby", source: "user" });
    await storeMemory(db, { content: "Alex uses Python at work daily", source: "user" });

    const results = await recallMemories(db, "Python");
    expect(results.length).toBe(3);
  });
});

// ── Memory → embedding write consistency ────────────────────────────

describe("memory writes → embedding recall", () => {
  it("memory without embedding is not found by embedding search", async () => {
    await storeMemory(db, {
      content: "A memory with no embedding vector",
      category: "general",
      source: "user",
      // no embedding
    });

    const results = await recallMemories(db, "xyzzy_no_keyword", {
      queryEmbedding: queryEmbeddings.pet,
    });

    // Should not find it — no embedding to compare against
    expect(results).toHaveLength(0);
  });

  it("updateMemoryEmbedding makes memory findable by embedding recall", async () => {
    const mem = await storeMemory(db, {
      content: "A fact about pets stored without embedding",
      category: "personal",
      source: "user",
    });

    // Not findable before embedding
    let results = await recallMemories(db, "xyzzy_no_keyword", {
      queryEmbedding: queryEmbeddings.pet,
    });
    expect(results.find((r) => r.id === mem.id)).toBeUndefined();

    // Add embedding in pet direction
    await updateMemoryEmbedding(db, mem.id, memoryEmbeddings.miso);

    // Now findable via embedding
    results = await recallMemories(db, "xyzzy_no_keyword", {
      queryEmbedding: queryEmbeddings.pet,
    });
    const found = results.find((r) => r.id === mem.id);
    expect(found).toBeDefined();
    expect(found!.matchType).toBe("embedding");
    expect(found!.score).toBeGreaterThan(0.9);
  });

  it("updateMemoryEmbedding changes which queries match", async () => {
    const mem = await storeMemory(db, {
      content: "A fact that changes topic cluster",
      category: "general",
      source: "user",
      embedding: JSON.stringify(memoryEmbeddings.miso), // starts in pet cluster
    });

    // Initially findable by pet query
    let results = await recallMemories(db, "xyzzy", {
      queryEmbedding: queryEmbeddings.pet,
    });
    expect(results.find((r) => r.id === mem.id)).toBeDefined();

    // Re-embed into work cluster
    await updateMemoryEmbedding(db, mem.id, memoryEmbeddings.datapipe);

    // No longer findable by pet query
    results = await recallMemories(db, "xyzzy", {
      queryEmbedding: queryEmbeddings.pet,
    });
    expect(results.find((r) => r.id === mem.id)).toBeUndefined();

    // Now findable by work query
    results = await recallMemories(db, "xyzzy", {
      queryEmbedding: queryEmbeddings.work,
    });
    expect(results.find((r) => r.id === mem.id)).toBeDefined();
  });
});

// ── Graph node write integrity ──────────────────────────────────────

describe("graph node writes", () => {
  it("upsertNode normalizes name to lowercase", async () => {
    const node = await upsertNode(db, { name: "AlExAnDeR", type: "person" });
    expect(node.name).toBe("alexander");
    expect(node.display_name).toBe("AlExAnDeR");
  });

  it("upsertNode is idempotent on same name+type", async () => {
    const first = await upsertNode(db, { name: "Alex", type: "person" });
    const second = await upsertNode(db, { name: "Alex", type: "person" });
    expect(first.id).toBe(second.id);
  });

  it("upsertNode creates separate nodes for different types", async () => {
    const person = await upsertNode(db, { name: "Rust", type: "person" });
    const concept = await upsertNode(db, { name: "Rust", type: "concept" });
    expect(person.id).not.toBe(concept.id);
  });

  it("findNodeByName is case-insensitive", async () => {
    await upsertNode(db, { name: "Portland", type: "place" });

    const found1 = await findNodeByName(db, "Portland");
    const found2 = await findNodeByName(db, "portland");
    const found3 = await findNodeByName(db, "PORTLAND");

    expect(found1).toBeDefined();
    expect(found1!.id).toBe(found2!.id);
    expect(found2!.id).toBe(found3!.id);
  });

  it("upsertNode fills description on existing node without one", async () => {
    const bare = await upsertNode(db, { name: "DataPipe", type: "entity" });
    expect(bare.description).toBeNull();

    const updated = await upsertNode(db, {
      name: "DataPipe",
      type: "entity",
      description: "Real-time data pipeline company",
    });

    expect(updated.id).toBe(bare.id);
    expect(updated.description).toBe("Real-time data pipeline company");
  });

  it("searchNodes finds nodes by partial name match", async () => {
    await upsertNode(db, { name: "Portland", type: "place" });
    await upsertNode(db, { name: "Port Angeles", type: "place" });

    const results = await searchNodes(db, "port", 10);
    expect(results.length).toBe(2);
  });
});

// ── Graph edge write integrity ──────────────────────────────────────

describe("graph edge writes", () => {
  it("upsertEdge with memory_id → getRelatedMemoryIds returns it", async () => {
    const alex = await upsertNode(db, { name: "Alex", type: "person" });
    const miso = await upsertNode(db, { name: "Miso", type: "entity" });
    const mem = await storeMemory(db, {
      content: "Alex has a cat named Miso",
      source: "user",
    });

    await upsertEdge(db, {
      source_id: alex.id,
      target_id: miso.id,
      relation: "owns",
      memory_id: mem.id,
    });

    const memIds = await getRelatedMemoryIds(db, [alex.id, miso.id]);
    expect(memIds).toContain(mem.id);
  });

  it("upsertEdge without memory_id → getRelatedMemoryIds skips it", async () => {
    const a = await upsertNode(db, { name: "A", type: "entity" });
    const b = await upsertNode(db, { name: "B", type: "entity" });

    await upsertEdge(db, {
      source_id: a.id,
      target_id: b.id,
      relation: "related_to",
      // no memory_id
    });

    const memIds = await getRelatedMemoryIds(db, [a.id, b.id]);
    expect(memIds).toHaveLength(0);
  });

  it("upsertEdge increments weight on duplicate", async () => {
    const a = await upsertNode(db, { name: "A", type: "entity" });
    const b = await upsertNode(db, { name: "B", type: "entity" });

    const first = await upsertEdge(db, {
      source_id: a.id,
      target_id: b.id,
      relation: "knows",
    });
    expect(first.weight).toBe(1);

    const second = await upsertEdge(db, {
      source_id: a.id,
      target_id: b.id,
      relation: "knows",
    });
    expect(second.weight).toBe(2);

    const third = await upsertEdge(db, {
      source_id: a.id,
      target_id: b.id,
      relation: "knows",
    });
    expect(third.weight).toBe(3);
  });

  it("different relations create separate edges", async () => {
    const alex = await upsertNode(db, { name: "Alex", type: "person" });
    const portland = await upsertNode(db, { name: "Portland", type: "place" });

    await upsertEdge(db, {
      source_id: alex.id,
      target_id: portland.id,
      relation: "lives_in",
    });
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: portland.id,
      relation: "was_born_in",
    });

    const edges = await getNodeEdges(db, alex.id);
    const portlandEdges = edges.filter((e) => e.target_id === portland.id);
    expect(portlandEdges).toHaveLength(2);
    expect(portlandEdges.map((e) => e.relation).toSorted()).toEqual(["lives_in", "was_born_in"]);
  });

  it("edges reachable from both source and target via traversal", async () => {
    const alex = await upsertNode(db, { name: "Alex", type: "person" });
    const miso = await upsertNode(db, { name: "Miso", type: "entity" });

    await upsertEdge(db, {
      source_id: alex.id,
      target_id: miso.id,
      relation: "owns",
    });

    // Traverse from Alex → should reach Miso
    const fromAlex = await traverseGraph(db, alex.id, 1);
    expect(fromAlex.map((t) => t.node.id)).toContain(miso.id);

    // Traverse from Miso → should reach Alex (edges are bidirectional in traversal)
    const fromMiso = await traverseGraph(db, miso.id, 1);
    expect(fromMiso.map((t) => t.node.id)).toContain(alex.id);
  });
});
