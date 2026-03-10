import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Normalize ISO timestamps (with T and Z) to SQLite datetime format (space-separated, no Z)
  // so that text-based ORDER BY works correctly
  await sql`
    UPDATE price_snapshots
    SET captured_at = REPLACE(REPLACE(captured_at, 'T', ' '), 'Z', '')
    WHERE captured_at LIKE '%T%'
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Non-reversible
}
