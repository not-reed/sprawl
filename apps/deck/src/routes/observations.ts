import { Hono } from "hono";
import { sql } from "kysely";
import type { Env } from "../server.js";

export const observationsRoutes = new Hono<Env>();

observationsRoutes.get("/conversations", async (c) => {
  const db = c.get("db");

  const conversations = await db
    .selectFrom("conversations")
    .select([
      "conversations.id",
      "conversations.source",
      "conversations.external_id",
      "conversations.created_at",
      "conversations.updated_at",
    ])
    .select(
      sql<number>`(SELECT count(*) FROM observations WHERE observations.conversation_id = conversations.id)`.as(
        "observation_count",
      ),
    )
    .orderBy("updated_at", "desc")
    .execute();

  return c.json({ conversations });
});

observationsRoutes.get("/conversations/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const observations = await db
    .selectFrom("observations")
    .selectAll()
    .where("conversation_id", "=", id)
    .where("superseded_at", "is", null)
    .orderBy("observation_date", "desc")
    .execute();

  return c.json({ observations });
});

observationsRoutes.get("/conversations/:id/all", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const observations = await db
    .selectFrom("observations")
    .selectAll()
    .where("conversation_id", "=", id)
    .orderBy("generation", "desc")
    .orderBy("observation_date", "desc")
    .execute();

  return c.json({ observations });
});
