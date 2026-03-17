import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE skill_instructions (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      instruction TEXT NOT NULL,
      embedding BLOB,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      FOREIGN KEY (skill_id) REFERENCES skills(id)
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_skill_instructions_skill_id ON skill_instructions(skill_id)
  `.execute(db);

  await sql`
    CREATE TABLE skill_instruction_deps (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'requires',
      PRIMARY KEY (from_id, to_id),
      FOREIGN KEY (from_id) REFERENCES skill_instructions(id),
      FOREIGN KEY (to_id) REFERENCES skill_instructions(id)
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_skill_instruction_deps_from ON skill_instruction_deps(from_id)
  `.execute(db);

  await sql`
    CREATE INDEX idx_skill_instruction_deps_to ON skill_instruction_deps(to_id)
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Additive only -- no-op
}
