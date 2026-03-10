import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("pending_asks")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("conversation_id", "text", (col) => col.notNull())
    .addColumn("chat_id", "text", (col) => col.notNull())
    .addColumn("question", "text", (col) => col.notNull())
    .addColumn("options", "text") // JSON string[] | null
    .addColumn("telegram_message_id", "integer")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("resolved_at", "text")
    .addColumn("response", "text")
    .execute();

  await db.schema
    .createIndex("idx_pending_asks_chat_resolved")
    .on("pending_asks")
    .columns(["chat_id", "resolved_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("pending_asks").execute();
}
