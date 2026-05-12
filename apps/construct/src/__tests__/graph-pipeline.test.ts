/**
 * Graph-specific pipeline tests: roundtrip retrieval and graph pattern validation.
 *
 * Split from store-pipeline.test.ts to keep file under max-lines limit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import {
  storeMemory,
  forgetMemory,
  upsertNode,
  upsertEdge,
  recallMemories,
  traverseGraph,
  getRelatedMemoryIds,
  findNodeByName,
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

// ── Write → retrieval roundtrip ─────────────────────────────────────

describe("write → retrieval roundtrip", () => {
  it("memory findable via all three paths: FTS5, embedding, graph", async () => {
    const mem = await storeMemory(db, {
      content: "Alex has a cat named Miso who is 3 years old",
      category: "personal",
      tags: "pet,cat",
      source: "user",
      embedding: JSON.stringify(memoryEmbeddings.miso),
    });

    const alex = await upsertNode(db, { name: "Alex", type: "person" });
    const miso = await upsertNode(db, { name: "Miso", type: "entity" });
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: miso.id,
      relation: "owns",
      memory_id: mem.id,
    });

    const ftsResults = await recallMemories(db, "cat Miso");
    expect(ftsResults.find((r) => r.id === mem.id)).toBeDefined();

    const embResults = await recallMemories(db, "xyzzy_no_keyword", {
      queryEmbedding: queryEmbeddings.pet,
    });
    const embMatch = embResults.find((r) => r.id === mem.id);
    expect(embMatch).toBeDefined();
    expect(embMatch!.score).toBeGreaterThan(0.9);

    const traversed = await traverseGraph(db, alex.id, 1);
    const reachedNodeIds = [alex.id, ...traversed.map((t) => t.node.id)];
    const graphMemIds = await getRelatedMemoryIds(db, reachedNodeIds);
    expect(graphMemIds).toContain(mem.id);
  });

  it("archived memory excluded from all recall paths", async () => {
    const mem = await storeMemory(db, {
      content: "Alex used to have a hamster named Biscuit",
      category: "personal",
      tags: "pet,hamster",
      source: "user",
      embedding: JSON.stringify(memoryEmbeddings.miso),
    });

    const alex = await upsertNode(db, { name: "Alex", type: "person" });
    const biscuit = await upsertNode(db, { name: "Biscuit", type: "entity" });
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: biscuit.id,
      relation: "owned",
      memory_id: mem.id,
    });

    await forgetMemory(db, mem.id);

    const ftsResults = await recallMemories(db, "hamster Biscuit");
    expect(ftsResults.find((r) => r.id === mem.id)).toBeUndefined();

    const embResults = await recallMemories(db, "xyzzy", {
      queryEmbedding: queryEmbeddings.pet,
    });
    expect(embResults.find((r) => r.id === mem.id)).toBeUndefined();

    const graphMemIds = await getRelatedMemoryIds(db, [alex.id, biscuit.id]);
    expect(graphMemIds).toContain(mem.id);

    const fetchedMems = await db
      .selectFrom("memories")
      .selectAll()
      .where("id", "in", graphMemIds)
      .where("archived_at", "is", null)
      .execute();
    expect(fetchedMems.find((m) => m.id === mem.id)).toBeUndefined();
  });
});

// ── Graph write patterns (simulating processMemoryForGraph) ─────────

describe("graph write patterns — connected graph", () => {
  it("multiple memories build up a connected graph", async () => {
    const mem1 = await storeMemory(db, {
      content: "Alex works at DataPipe as a backend engineer",
      source: "user",
      category: "work",
    });
    const alex = await upsertNode(db, { name: "Alex", type: "person" });
    const datapipe = await upsertNode(db, { name: "DataPipe", type: "entity" });
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: datapipe.id,
      relation: "works_at",
      memory_id: mem1.id,
    });

    const mem2 = await storeMemory(db, {
      content: "Alex lives in Portland, Oregon",
      source: "user",
      category: "personal",
    });
    const alex2 = await upsertNode(db, { name: "Alex", type: "person" });
    const portland = await upsertNode(db, { name: "Portland", type: "place" });
    await upsertEdge(db, {
      source_id: alex2.id,
      target_id: portland.id,
      relation: "lives_in",
      memory_id: mem2.id,
    });

    const mem3 = await storeMemory(db, {
      content: "DataPipe is headquartered in Portland",
      source: "user",
      category: "work",
    });
    const datapipe2 = await upsertNode(db, { name: "DataPipe", type: "entity" });
    const portland2 = await upsertNode(db, { name: "Portland", type: "place" });
    await upsertEdge(db, {
      source_id: datapipe2.id,
      target_id: portland2.id,
      relation: "based_in",
      memory_id: mem3.id,
    });

    expect(alex.id).toBe(alex2.id);
    expect(datapipe.id).toBe(datapipe2.id);
    expect(portland.id).toBe(portland2.id);

    const fromPortland = await traverseGraph(db, portland.id, 1);
    const reached = fromPortland.map((t) => t.node.id);
    expect(reached).toContain(alex.id);
    expect(reached).toContain(datapipe.id);

    const allNodes = [portland.id, ...reached];
    const memIds = await getRelatedMemoryIds(db, allNodes);
    expect(memIds).toContain(mem1.id);
    expect(memIds).toContain(mem2.id);
    expect(memIds).toContain(mem3.id);
  });

  it("relationship referencing unknown entity creates generic node", async () => {
    const mem = await storeMemory(db, {
      content: "Alex mentioned Sarah but extraction only found Alex as an entity",
      source: "user",
    });

    const alex = await upsertNode(db, { name: "Alex", type: "person" });
    let sarah = await findNodeByName(db, "Sarah");
    if (!sarah) {
      sarah = await upsertNode(db, { name: "Sarah", type: "entity" });
    }
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: sarah.id,
      relation: "knows",
      memory_id: mem.id,
    });

    const found = await findNodeByName(db, "sarah");
    expect(found).toBeDefined();
    expect(found!.node_type).toBe("entity");

    const sarah2 = await upsertNode(db, { name: "Sarah", type: "entity" });
    expect(sarah2.id).toBe(sarah.id);
  });
});

describe("graph write patterns — weights and discovery", () => {
  it("repeated processing of same fact increments edge weight", async () => {
    const alex = await upsertNode(db, { name: "Alex", type: "person" });
    const portland = await upsertNode(db, { name: "Portland", type: "place" });

    const mems = await Promise.all([
      storeMemory(db, { content: "Alex lives in Portland", source: "user" }),
      storeMemory(db, { content: "Alex resides in Portland, OR", source: "user" }),
      storeMemory(db, { content: "Alex moved to Portland last year", source: "user" }),
    ]);

    for (const mem of mems) {
      await upsertEdge(db, {
        source_id: alex.id,
        target_id: portland.id,
        relation: "lives_in",
        memory_id: mem.id,
      });
    }

    const edges = await getNodeEdges(db, alex.id);
    const livesIn = edges.find((e) => e.target_id === portland.id && e.relation === "lives_in");
    expect(livesIn).toBeDefined();
    expect(livesIn!.weight).toBe(3);
  });

  it("hub node connects disparate facts for cross-topic discovery", async () => {
    const mem1 = await storeMemory(db, {
      content: "Alex has a cat named Miso",
      source: "user",
      embedding: JSON.stringify(memoryEmbeddings.miso),
    });
    const mem2 = await storeMemory(db, {
      content: "Alex is allergic to shellfish",
      source: "user",
      embedding: JSON.stringify(memoryEmbeddings.shellfish),
    });

    const alex = await upsertNode(db, { name: "Alex", type: "person" });
    const miso = await upsertNode(db, { name: "Miso", type: "entity" });
    const shellfish = await upsertNode(db, { name: "Shellfish", type: "concept" });

    await upsertEdge(db, {
      source_id: alex.id,
      target_id: miso.id,
      relation: "owns",
      memory_id: mem1.id,
    });
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: shellfish.id,
      relation: "allergic_to",
      memory_id: mem2.id,
    });

    const directResults = await recallMemories(db, "Miso", {
      queryEmbedding: queryEmbeddings.pet,
    });
    const directIds = new Set(directResults.map((r) => r.id));
    expect(directIds.has(mem1.id)).toBe(true);
    expect(directIds.has(mem2.id)).toBe(false);

    const misoNode = await findNodeByName(db, "miso");
    const traversed = await traverseGraph(db, misoNode!.id, 2);
    const allNodeIds = [misoNode!.id, ...traversed.map((t) => t.node.id)];
    const graphMemIds = await getRelatedMemoryIds(db, allNodeIds);

    expect(graphMemIds).toContain(mem2.id);

    const allMemIds = new Set([...directIds, ...graphMemIds]);
    expect(allMemIds.has(mem1.id)).toBe(true);
    expect(allMemIds.has(mem2.id)).toBe(true);
  });
});
