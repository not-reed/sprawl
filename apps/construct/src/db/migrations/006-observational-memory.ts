import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
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

  // Add observation tracking columns to conversations
  await db.schema
    .alterTable("conversations")
    .addColumn("observed_up_to_message_id", "text")
    .execute();

  await db.schema
    .alterTable("conversations")
    .addColumn("observation_token_count", "integer", (col) => col.defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("observations").execute();

  // SQLite doesn't support DROP COLUMN before 3.35.0, but Kysely handles it
  await db.schema.alterTable("conversations").dropColumn("observed_up_to_message_id").execute();

  await db.schema.alterTable("conversations").dropColumn("observation_token_count").execute();
}
