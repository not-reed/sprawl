import { Hono } from "hono";
import { sql } from "kysely";
import type { Env } from "../server.js";

export const statsRoutes = new Hono<Env>();

statsRoutes.get("/", async (c) => {
  const db = c.get("db");

  const [memories, nodes, edges, observations, categories, daily] = await Promise.all([
    db
      .selectFrom("memories")
      .select(sql<number>`count(*)`.as("count"))
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow(),

    db
      .selectFrom("graph_nodes")
      .select(sql<number>`count(*)`.as("count"))
      .executeTakeFirstOrThrow(),

    db
      .selectFrom("graph_edges")
      .select(sql<number>`count(*)`.as("count"))
      .executeTakeFirstOrThrow(),

    db
      .selectFrom("observations")
      .select(sql<number>`count(*)`.as("count"))
      .where("superseded_at", "is", null)
      .executeTakeFirstOrThrow(),

    db
      .selectFrom("memories")
      .select(["category", sql<number>`count(*)`.as("count")])
      .where("archived_at", "is", null)
      .groupBy("category")
      .orderBy(sql`count(*)`, "desc")
      .execute(),

    db
      .selectFrom("memories")
      .select([sql<string>`date(created_at)`.as("date"), sql<number>`count(*)`.as("count")])
      .where("archived_at", "is", null)
      .groupBy(sql`date(created_at)`)
      .orderBy(sql`date(created_at)`, "desc")
      .limit(30)
      .execute(),
  ]);

  return c.json({
    memories: Number(memories.count),
    nodes: Number(nodes.count),
    edges: Number(edges.count),
    observations: Number(observations.count),
    categories: categories.map((r) => ({
      category: r.category,
      count: Number(r.count),
    })),
    daily: daily.map((r) => ({
      date: r.date,
      count: Number(r.count),
    })),
  });
});
