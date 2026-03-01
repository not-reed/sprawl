import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE signals ADD COLUMN timeframe TEXT NOT NULL DEFAULT 'short'`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE signals DROP COLUMN timeframe`.execute(db)
}
