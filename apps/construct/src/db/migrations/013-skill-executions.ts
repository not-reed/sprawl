import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE skill_executions (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      had_tool_errors INTEGER NOT NULL DEFAULT 0,
      tool_error_details TEXT,
      implicated_instruction_id TEXT,
      success INTEGER,
      feedback_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      FOREIGN KEY (skill_id) REFERENCES skills(id),
      FOREIGN KEY (implicated_instruction_id) REFERENCES skill_instructions(id)
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_skill_executions_skill_id ON skill_executions(skill_id)
  `.execute(db);

  await sql`
    CREATE INDEX idx_skill_executions_conversation_id ON skill_executions(conversation_id)
  `.execute(db);

  await sql`
    CREATE INDEX idx_skill_executions_implicated ON skill_executions(implicated_instruction_id)
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Additive only -- no-op
}
