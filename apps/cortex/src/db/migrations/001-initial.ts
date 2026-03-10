import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Cairn base tables ─────────────────────────────────────────────────

  // memories
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

  await db.schema.createIndex("idx_memories_category").on("memories").column("category").execute();

  await db.schema
    .createIndex("idx_memories_archived")
    .on("memories")
    .column("archived_at")
    .execute();

  // memories FTS5
  await sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      content,
      tags,
      category UNINDEXED,
      content=memories,
      content_rowid=rowid
    )
  `.execute(db);

  await sql`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, id, content, tags, category)
      VALUES (NEW.rowid, NEW.id, NEW.content, NEW.tags, NEW.category);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, content, tags, category)
      VALUES ('delete', OLD.rowid, OLD.id, OLD.content, OLD.tags, OLD.category);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, content, tags, category)
      VALUES ('delete', OLD.rowid, OLD.id, OLD.content, OLD.tags, OLD.category);
      INSERT INTO memories_fts(rowid, id, content, tags, category)
      VALUES (NEW.rowid, NEW.id, NEW.content, NEW.tags, NEW.category);
    END
  `.execute(db);

  // conversations
  await db.schema
    .createTable("conversations")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("external_id", "text")
    .addColumn("observed_up_to_message_id", "text")
    .addColumn("observation_token_count", "integer", (col) => col.defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_conversations_external")
    .on("conversations")
    .column("external_id")
    .execute();

  // messages
  await db.schema
    .createTable("messages")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("conversation_id", "text", (col) => col.notNull().references("conversations.id"))
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("tool_calls", "text")
    .addColumn("telegram_message_id", "integer")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_messages_conversation")
    .on("messages")
    .column("conversation_id")
    .execute();

  // ai_usage
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

  // graph_nodes
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
    .createIndex("idx_gn_name_type")
    .on("graph_nodes")
    .columns(["name", "node_type"])
    .unique()
    .execute();

  // graph_edges
  await db.schema
    .createTable("graph_edges")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("source_id", "text", (col) => col.notNull().references("graph_nodes.id"))
    .addColumn("target_id", "text", (col) => col.notNull().references("graph_nodes.id"))
    .addColumn("relation", "text", (col) => col.notNull())
    .addColumn("weight", "real", (col) => col.defaultTo(1.0))
    .addColumn("properties", "text")
    .addColumn("memory_id", "text", (col) => col.references("memories.id"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema.createIndex("idx_ge_source").on("graph_edges").column("source_id").execute();

  await db.schema.createIndex("idx_ge_target").on("graph_edges").column("target_id").execute();

  await db.schema
    .createIndex("idx_ge_unique")
    .on("graph_edges")
    .columns(["source_id", "target_id", "relation"])
    .unique()
    .execute();

  // observations
  await db.schema
    .createTable("observations")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("conversation_id", "text", (col) => col.notNull().references("conversations.id"))
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("priority", "text", (col) => col.defaultTo("medium"))
    .addColumn("observation_date", "text", (col) => col.notNull())
    .addColumn("source_message_ids", "text")
    .addColumn("token_count", "integer")
    .addColumn("generation", "integer", (col) => col.defaultTo(0))
    .addColumn("superseded_at", "text")
    .addColumn("promoted_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_obs_conv")
    .on("observations")
    .column("conversation_id")
    .execute();

  await db.schema
    .createIndex("idx_obs_active")
    .on("observations")
    .columns(["conversation_id", "superseded_at"])
    .execute();

  // ── Cortex-specific tables ────────────────────────────────────────────

  // tracked_tokens
  await db.schema
    .createTable("tracked_tokens")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("symbol", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("added_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  // price_snapshots
  await db.schema
    .createTable("price_snapshots")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("token_id", "text", (col) => col.notNull().references("tracked_tokens.id"))
    .addColumn("price_usd", "real", (col) => col.notNull())
    .addColumn("market_cap", "real")
    .addColumn("volume_24h", "real")
    .addColumn("change_24h", "real")
    .addColumn("change_7d", "real")
    .addColumn("captured_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_ps_token_time")
    .on("price_snapshots")
    .columns(["token_id", "captured_at"])
    .execute();

  // news_items
  await db.schema
    .createTable("news_items")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("external_id", "text", (col) => col.unique().notNull())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("url", "text")
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("published_at", "text", (col) => col.notNull())
    .addColumn("tokens_mentioned", "text")
    .addColumn("ingested_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("memory_id", "text", (col) => col.references("memories.id"))
    .execute();

  // signals
  await db.schema
    .createTable("signals")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("token_id", "text", (col) => col.notNull().references("tracked_tokens.id"))
    .addColumn("signal_type", "text", (col) => col.notNull())
    .addColumn("confidence", "real", (col) => col.notNull())
    .addColumn("reasoning", "text", (col) => col.notNull())
    .addColumn("key_factors", "text")
    .addColumn("memory_ids", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema.createIndex("idx_signals_token").on("signals").column("token_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("signals").execute();
  await db.schema.dropTable("news_items").execute();
  await db.schema.dropTable("price_snapshots").execute();
  await db.schema.dropTable("tracked_tokens").execute();
  await db.schema.dropTable("observations").execute();
  await db.schema.dropTable("graph_edges").execute();
  await db.schema.dropTable("graph_nodes").execute();
  await db.schema.dropTable("ai_usage").execute();
  await db.schema.dropTable("messages").execute();
  await db.schema.dropTable("conversations").execute();
  await sql`DROP TRIGGER IF EXISTS memories_au`.execute(db);
  await sql`DROP TRIGGER IF EXISTS memories_ad`.execute(db);
  await sql`DROP TRIGGER IF EXISTS memories_ai`.execute(db);
  await sql`DROP TABLE IF EXISTS memories_fts`.execute(db);
  await db.schema.dropTable("memories").execute();
}
