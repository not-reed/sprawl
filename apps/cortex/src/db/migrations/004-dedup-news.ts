import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Remove duplicate news items, keeping the earliest ingested copy per title
  await sql`
    DELETE FROM news_items WHERE id NOT IN (
      SELECT MIN(id) FROM news_items GROUP BY title
    )
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Non-reversible — deleted duplicates can't be restored
}
