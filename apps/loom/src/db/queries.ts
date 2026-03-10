import type { Kysely } from "kysely";
import { sql } from "kysely";
import { nanoid } from "nanoid";
import type { Database, Campaign, Session } from "./schema.js";

type DB = Kysely<Database>;

export {
  storeMemory,
  recallMemories,
  getRecentMemories,
  trackUsage,
  updateMemoryEmbedding,
} from "@repo/cairn";

// --- Campaigns ---

export async function createCampaign(
  db: DB,
  data: { name: string; system?: string; description?: string },
): Promise<Campaign> {
  const id = nanoid();
  await db
    .insertInto("campaigns")
    .values({
      id,
      name: data.name,
      system: data.system ?? null,
      description: data.description ?? null,
    })
    .execute();

  return db.selectFrom("campaigns").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

export async function listCampaigns(db: DB): Promise<Campaign[]> {
  return db.selectFrom("campaigns").selectAll().orderBy("updated_at", "desc").execute();
}

export async function getCampaign(db: DB, id: string): Promise<Campaign | undefined> {
  return db.selectFrom("campaigns").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function deleteCampaign(db: DB, id: string): Promise<boolean> {
  const result = await db.deleteFrom("campaigns").where("id", "=", id).executeTakeFirst();
  return (result.numDeletedRows ?? 0n) > 0n;
}

// --- Sessions ---

export async function createSession(
  db: DB,
  data: { campaignId: string; name?: string; mode?: string },
): Promise<Session> {
  const sessionId = nanoid();
  const conversationId = nanoid();

  await db
    .insertInto("conversations")
    .values({ id: conversationId, source: "loom", external_id: null })
    .execute();

  await db
    .insertInto("sessions")
    .values({
      id: sessionId,
      campaign_id: data.campaignId,
      conversation_id: conversationId,
      name: data.name ?? null,
      mode: data.mode ?? "play",
    })
    .execute();

  return db
    .selectFrom("sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .executeTakeFirstOrThrow();
}

export async function getSession(db: DB, id: string): Promise<Session | undefined> {
  return db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function getSessionsForCampaign(db: DB, campaignId: string): Promise<Session[]> {
  return db
    .selectFrom("sessions")
    .selectAll()
    .where("campaign_id", "=", campaignId)
    .orderBy("created_at", "desc")
    .execute();
}

export async function updateSession(
  db: DB,
  id: string,
  data: { name?: string; mode?: string; status?: string },
): Promise<Session | undefined> {
  const updates: Record<string, unknown> = {
    updated_at: sql<string>`datetime('now')`,
  };
  if (data.name !== undefined) updates.name = data.name;
  if (data.mode !== undefined) updates.mode = data.mode;
  if (data.status !== undefined) updates.status = data.status;

  await db.updateTable("sessions").set(updates).where("id", "=", id).execute();

  return getSession(db, id);
}

// --- Messages ---

export async function saveMessage(
  db: DB,
  message: { conversation_id: string; role: string; content: string; tool_calls?: string | null },
) {
  const id = nanoid();
  await db
    .insertInto("messages")
    .values({
      id,
      conversation_id: message.conversation_id,
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls ?? null,
    })
    .execute();
  return id;
}

export async function getMessages(db: DB, conversationId: string, limit = 100) {
  return db
    .selectFrom("messages")
    .selectAll()
    .where("conversation_id", "=", conversationId)
    .orderBy("created_at", "asc")
    .limit(limit)
    .execute();
}
