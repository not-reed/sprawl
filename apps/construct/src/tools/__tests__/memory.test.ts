import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { upsertNode, upsertEdge, PipelineQueue } from "@repo/cairn";
import { createMemoryTool } from "../core/memory.js";
import { setupDb } from "../../__tests__/fixtures.js";

let db: Kysely<Database>;

beforeEach(async () => {
  db = await setupDb();
});

afterEach(async () => {
  await db.destroy();
});

describe("memory tool", () => {
  it("stores a memory with action=store", async () => {
    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", {
      action: "store",
      content: "Test memory content",
      category: "fact",
    });
    expect(result.output).toContain("Stored memory");
    expect(result.output).toContain("Test memory content");
    expect(result.output).toContain("fact");
  });

  it("recalls memories with action=recall", async () => {
    const tool = createMemoryTool(db);
    await tool.execute("t1", {
      action: "store",
      content: "Dentist appointment on March 15",
      category: "reminder",
      tags: ["dentist", "appointment"],
    });

    const result = await tool.execute("t2", { action: "recall", query: "dentist" });
    expect(result.output).toContain("dentist");
  });

  it("forgets a memory by id with action=forget", async () => {
    const tool = createMemoryTool(db);
    const storeResult = await tool.execute("t1", {
      action: "store",
      content: "Forget me",
    });
    const id = (storeResult.details as any).memory.id;

    const result = await tool.execute("t2", { action: "forget", id });
    expect(result.output).toContain("Archived");
  });

  it("forgets by query search with action=forget", async () => {
    const tool = createMemoryTool(db);
    await tool.execute("t1", { action: "store", content: "Remember the milk" });

    const result = await tool.execute("t2", { action: "forget", query: "milk" });
    expect(result.output).toContain("Found");
    expect(result.output).toContain("milk");
  });

  it("shows stats with action=stats", async () => {
    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", { action: "stats", days: 30 });
    expect(result.output).toContain("Usage stats");
    expect(result.output).toContain("30 day(s)");
  });

  it("returns error for unknown action", async () => {
    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", { action: "unknown" } as any);
    expect(result.output).toContain("Unknown action");
  });
});

describe("memory tool: graph action", () => {
  it("requires a query parameter", async () => {
    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", { action: "graph" });
    expect(result.output).toContain('requires a "query"');
  });

  it("search returns matching nodes when query is not an exact node name", async () => {
    await upsertNode(db, { name: "Rustlings", type: "concept", description: "Exercise series" });
    await upsertNode(db, { name: "Rust Book", type: "concept", description: "The Book" });

    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", { action: "graph", query: "rust" });

    expect(result.output).toContain("Found");
    expect((result.details as any).nodes.length).toBeGreaterThan(0);
  });

  it("explore returns edges and traversal when query matches a node name", async () => {
    const alex = await upsertNode(db, { name: "Alex", type: "person" });
    const portland = await upsertNode(db, { name: "Portland", type: "place" });
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: portland.id,
      relation: "lives_in",
    });

    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", { action: "graph", query: "Alex" });

    expect(result.output).toContain("Node: Alex");
    expect(result.output).toContain("lives_in");
    expect((result.details as any).node.id).toBe(alex.id);
  });

  it("explore reports no connections for an isolated node", async () => {
    await upsertNode(db, { name: "Loner", type: "person" });
    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", { action: "graph", query: "Loner" });
    expect(result.output).toContain("No connections found");
  });

  it("connect finds path between two named nodes", async () => {
    const a = await upsertNode(db, { name: "Alpha", type: "concept" });
    const b = await upsertNode(db, { name: "Bravo", type: "concept" });
    await upsertEdge(db, { source_id: a.id, target_id: b.id, relation: "links_to" });

    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", { action: "graph", query: "Alpha", target: "Bravo" });

    expect(result.output).toContain('"Alpha" connects to "Bravo"');
    expect(result.output).toContain("links_to");
  });

  it("connect reports no connection when path missing", async () => {
    await upsertNode(db, { name: "Island1", type: "concept" });
    await upsertNode(db, { name: "Island2", type: "concept" });

    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", {
      action: "graph",
      query: "Island1",
      target: "Island2",
    });
    expect(result.output).toContain("No connection found");
  });

  it("connect reports missing source", async () => {
    await upsertNode(db, { name: "Real", type: "concept" });
    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", {
      action: "graph",
      query: "Phantom",
      target: "Real",
    });
    expect(result.output).toContain('No node found for "Phantom"');
  });

  it("search returns no results message when nothing matches", async () => {
    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", { action: "graph", query: "nonexistent-thing" });
    expect(result.output).toContain("No graph nodes matching");
  });
});

describe("memory tool: health action", () => {
  it("reports queue not configured when no pipelineQueue", async () => {
    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", { action: "health" });
    expect(result.output).toContain("Memory System Health");
    expect(result.output).toContain("Pipeline Queue");
    expect(result.output).toContain("(not configured)");
    expect((result.details as any).pipelineQueueConfigured).toBe(false);
  });

  it("reports queue status when pipelineQueue is provided", async () => {
    const fakeManager = {} as any;
    const queue = new PipelineQueue(db as any, fakeManager);

    const tool = createMemoryTool(db, undefined, undefined, undefined, queue);
    const result = await tool.execute("t1", { action: "health" });

    expect(result.output).toContain("Pipeline Queue");
    expect(result.output).toContain("Pending:");
    expect(result.output).toContain("Running:");
    expect((result.details as any).pipelineQueueConfigured).toBe(true);
  });

  it("includes memory statistics counts", async () => {
    await upsertNode(db, { name: "TestNode", type: "concept" });
    const tool = createMemoryTool(db);
    const result = await tool.execute("t1", { action: "health" });
    expect(result.output).toContain("Memory Statistics");
    expect(result.output).toContain("Graph nodes:");
  });
});
