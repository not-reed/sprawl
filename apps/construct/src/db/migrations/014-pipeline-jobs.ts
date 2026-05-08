import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE pipeline_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      completed_at TEXT
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_pipeline_jobs_status_next ON pipeline_jobs(status, next_attempt_at)
  `.execute(db);

  await sql`
    CREATE INDEX idx_pipeline_jobs_conversation ON pipeline_jobs(conversation_id)
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Additive only -- no-op
}
