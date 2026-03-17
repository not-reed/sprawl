import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      embedding BLOB,
      version INTEGER NOT NULL DEFAULT 1,
      parent_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX idx_skills_name ON skills(name) WHERE status = 'active'
  `.execute(db);

  await sql`
    CREATE INDEX idx_skills_parent_id ON skills(parent_id)
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Additive only -- no-op
}
