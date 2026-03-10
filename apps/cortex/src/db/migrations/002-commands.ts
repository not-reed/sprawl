import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("commands")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("command", "text", (col) => col.notNull())
    .addColumn("args", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("completed_at", "text")
    .execute();

  await db.schema
    .createIndex("idx_commands_pending")
    .on("commands")
    .column("completed_at")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("commands").execute();
}
