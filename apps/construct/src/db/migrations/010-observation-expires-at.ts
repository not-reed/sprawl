import { type Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE observations ADD COLUMN expires_at TEXT`.execute(db)
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // SQLite doesn't support DROP COLUMN before 3.35.0 — recreate table if needed
  // For now, this is a no-op since we follow additive-only migrations
}
