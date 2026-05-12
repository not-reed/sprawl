/**
 * Shared in-memory SQLite database helper for Cairn integration tests.
 *
 * Creates all CairnDatabase tables (memories, conversations, messages,
 * ai_usage, observations, graph_nodes, graph_edges) without requiring
 * consumer-specific migrations.
 *
 * Usage:
 *   const db = await setupCairnTestDb()
 *   // ... tests ...
 *   await db.destroy()
 */

import { Kysely, sql } from "kysely";
import { createDb } from "@repo/db";
import type { CairnDatabase } from "../db/types.js";

async function createMemoriesTable(db: Kysely<CairnDatabase>) {
  await db.schema
    .createTable("memories")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("category", "text", (col) => col.notNull().defaultTo("general"))
    .addColumn("tags", "text")
    .addColumn("source", "text", (col) => col.notNull().defaultTo("user"))
    .addColumn("embedding", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("archived_at", "text")
    .execute();

  await sql`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content=memories, content_rowid=rowid)`.execute(
    db,
  );

  await sql`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END
  `.execute(db);
}

async function createConversationsTable(db: Kysely<CairnDatabase>) {
  await db.schema
    .createTable("conversations")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("external_id", "text")
    .addColumn("observed_up_to_message_id", "text")
    .addColumn("observation_token_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();
}

async function createMessagesTable(db: Kysely<CairnDatabase>) {
  await db.schema
    .createTable("messages")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("conversation_id", "text", (col) => col.notNull().references("conversations.id"))
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("tool_calls", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();
}

async function createAiUsageTable(db: Kysely<CairnDatabase>) {
  await db.schema
    .createTable("ai_usage")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("model", "text", (col) => col.notNull())
    .addColumn("input_tokens", "integer")
    .addColumn("output_tokens", "integer")
    .addColumn("cost_usd", "real")
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();
}

async function createGraphTables(db: Kysely<CairnDatabase>) {
  await db.schema
    .createTable("graph_nodes")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("display_name", "text", (col) => col.notNull())
    .addColumn("node_type", "text", (col) => col.notNull().defaultTo("entity"))
    .addColumn("description", "text")
    .addColumn("embedding", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_graph_nodes_name_type")
    .on("graph_nodes")
    .columns(["name", "node_type"])
    .unique()
    .execute();

  await db.schema
    .createTable("graph_edges")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("source_id", "text", (col) => col.notNull().references("graph_nodes.id"))
    .addColumn("target_id", "text", (col) => col.notNull().references("graph_nodes.id"))
    .addColumn("relation", "text", (col) => col.notNull())
    .addColumn("weight", "real", (col) => col.notNull().defaultTo(1))
    .addColumn("properties", "text")
    .addColumn("memory_id", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_graph_edges_source")
    .on("graph_edges")
    .column("source_id")
    .execute();
  await db.schema
    .createIndex("idx_graph_edges_target")
    .on("graph_edges")
    .column("target_id")
    .execute();
}

async function createObservationsTable(db: Kysely<CairnDatabase>) {
  await db.schema
    .createTable("observations")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("conversation_id", "text", (col) => col.notNull().references("conversations.id"))
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("priority", "text", (col) => col.notNull().defaultTo("medium"))
    .addColumn("observation_date", "text", (col) => col.notNull())
    .addColumn("source_message_ids", "text")
    .addColumn("token_count", "integer")
    .addColumn("generation", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("superseded_at", "text")
    .addColumn("promoted_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();
}

async function createPipelineJobsTable(db: Kysely<CairnDatabase>) {
  await db.schema
    .createTable("pipeline_jobs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("conversation_id", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("max_attempts", "integer", (col) => col.notNull().defaultTo(3))
    .addColumn("last_error", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("next_attempt_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("completed_at", "text")
    .execute();
}

async function createTestIndexes(db: Kysely<CairnDatabase>) {
  await db.schema.createIndex("idx_memories_category").on("memories").column("category").execute();
  await db.schema
    .createIndex("idx_memories_archived")
    .on("memories")
    .column("archived_at")
    .execute();
  await db.schema
    .createIndex("idx_messages_conversation")
    .on("messages")
    .column("conversation_id")
    .execute();
}

export async function setupCairnTestDb(): Promise<Kysely<CairnDatabase>> {
  const { db } = createDb<CairnDatabase>(":memory:");
  await createMemoriesTable(db);
  await createConversationsTable(db);
  await createMessagesTable(db);
  await createAiUsageTable(db);
  await createGraphTables(db);
  await createObservationsTable(db);
  await createPipelineJobsTable(db);
  await createTestIndexes(db);
  return db;
}
