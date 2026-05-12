import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Kysely } from "kysely";
import type { CairnDatabase } from "../../db/types.js";
import { setupCairnTestDb } from "../../__tests__/test-db.js";
import { upsertNode, upsertEdge, traverseGraph, getEdgesForNodes } from "../queries.js";

let db: Kysely<CairnDatabase>;

beforeEach(async () => {
  db = await setupCairnTestDb();
});

afterEach(async () => {
  await db.destroy();
});

describe("traverseGraph", () => {
  it("finds reachable nodes within maxDepth", async () => {
    const a = await upsertNode(db, { name: "A", type: "concept" });
    const b = await upsertNode(db, { name: "B", type: "concept" });
    const c = await upsertNode(db, { name: "C", type: "concept" });
    await upsertEdge(db, { source_id: a.id, target_id: b.id, relation: "links_to" });
    await upsertEdge(db, { source_id: b.id, target_id: c.id, relation: "links_to" });

    const result = await traverseGraph(db, a.id, 2);
    const ids = result.map((r) => r.node.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(a.id);
  });

  it("does not loop infinitely on cycles", async () => {
    const a = await upsertNode(db, { name: "A", type: "concept" });
    const b = await upsertNode(db, { name: "B", type: "concept" });
    const c = await upsertNode(db, { name: "C", type: "concept" });
    await upsertEdge(db, { source_id: a.id, target_id: b.id, relation: "ab" });
    await upsertEdge(db, { source_id: b.id, target_id: c.id, relation: "bc" });
    await upsertEdge(db, { source_id: c.id, target_id: b.id, relation: "cb" });

    const result = await traverseGraph(db, a.id, 5);
    const ids = result.map((r) => r.node.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(a.id);
    // Without cycle detection this would blow up to maxDepth rows.
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("follows bidirectional edges", async () => {
    const a = await upsertNode(db, { name: "A", type: "concept" });
    const b = await upsertNode(db, { name: "B", type: "concept" });
    await upsertEdge(db, { source_id: a.id, target_id: b.id, relation: "parent_of" });

    const fromB = await traverseGraph(db, b.id, 1);
    expect(fromB.map((r) => r.node.id)).toContain(a.id);
  });

  it("respects maxDepth limit", async () => {
    const a = await upsertNode(db, { name: "A", type: "concept" });
    const b = await upsertNode(db, { name: "B", type: "concept" });
    const c = await upsertNode(db, { name: "C", type: "concept" });
    await upsertEdge(db, { source_id: a.id, target_id: b.id, relation: "ab" });
    await upsertEdge(db, { source_id: b.id, target_id: c.id, relation: "bc" });

    const depth1 = await traverseGraph(db, a.id, 1);
    expect(depth1.map((r) => r.node.id)).toContain(b.id);
    expect(depth1.map((r) => r.node.id)).not.toContain(c.id);

    const depth2 = await traverseGraph(db, a.id, 2);
    expect(depth2.map((r) => r.node.id)).toContain(c.id);
  });
});

describe("getEdgesForNodes", () => {
  it("returns edges for multiple nodes in a single query", async () => {
    const a = await upsertNode(db, { name: "A", type: "concept" });
    const b = await upsertNode(db, { name: "B", type: "concept" });
    const c = await upsertNode(db, { name: "C", type: "concept" });
    await upsertEdge(db, { source_id: a.id, target_id: b.id, relation: "ab" });
    await upsertEdge(db, { source_id: b.id, target_id: c.id, relation: "bc" });

    const edges = await getEdgesForNodes(db, [a.id, c.id]);
    expect(edges).toHaveLength(2);
    const rels = edges.map((e) => e.relation).toSorted();
    expect(rels).toEqual(["ab", "bc"]);
  });

  it("returns empty array for empty input", async () => {
    const edges = await getEdgesForNodes(db, []);
    expect(edges).toEqual([]);
  });
});
