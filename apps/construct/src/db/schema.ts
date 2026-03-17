import type { Generated, Insertable, Selectable, Updateable } from "kysely";
import type { CairnDatabase, MessageTable as CairnMessageTable } from "@repo/cairn";

interface ConstructMessageTable extends CairnMessageTable {
  telegram_message_id: number | null;
}

// Index signature needed so Kysely<Database> is assignable to cairn's
// Kysely<CairnDatabase & Record<string, any>> (Kysely is invariant).
export interface Database extends CairnDatabase {
  messages: ConstructMessageTable;
  schedules: ScheduleTable;
  settings: SettingTable;
  secrets: SecretTable;
  pending_asks: PendingAskTable;
  skills: SkillTable;
  skill_instructions: SkillInstructionTable;
  skill_instruction_deps: SkillInstructionDepTable;
  skill_executions: SkillExecutionTable;
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface ScheduleTable {
  id: string;
  description: string;
  cron_expression: string | null;
  run_at: string | null;
  message: string;
  prompt: string | null;
  chat_id: string;
  active: Generated<number>;
  last_run_at: string | null;
  created_at: Generated<string>;
}

export type Schedule = Selectable<ScheduleTable>;
export type NewSchedule = Insertable<ScheduleTable>;
export type ScheduleUpdate = Updateable<ScheduleTable>;

export interface SettingTable {
  key: string;
  value: string;
  updated_at: Generated<string>;
}

export type Setting = Selectable<SettingTable>;

export interface SecretTable {
  key: string;
  value: string;
  source: Generated<string>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export type Secret = Selectable<SecretTable>;

export interface PendingAskTable {
  id: string;
  conversation_id: string;
  chat_id: string;
  question: string;
  options: string | null; // JSON string[]
  telegram_message_id: number | null;
  created_at: Generated<string>;
  resolved_at: string | null;
  response: string | null;
}

export type PendingAsk = Selectable<PendingAskTable>;

export interface SkillTable {
  id: string;
  name: string;
  description: string;
  body: string;
  embedding: Buffer | null;
  version: number;
  parent_id: string | null;
  status: string;
  use_count: number;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export type Skill = Selectable<SkillTable>;
export type NewSkill = Insertable<SkillTable>;
export type SkillUpdate = Updateable<SkillTable>;

export interface SkillInstructionTable {
  id: string;
  skill_id: string;
  instruction: string;
  embedding: Buffer | null;
  position: number;
  created_at: Generated<string>;
}

export type SkillInstruction = Selectable<SkillInstructionTable>;
export type NewSkillInstruction = Insertable<SkillInstructionTable>;

export interface SkillInstructionDepTable {
  from_id: string;
  to_id: string;
  relation: string;
}

export type SkillInstructionDep = Selectable<SkillInstructionDepTable>;
export type NewSkillInstructionDep = Insertable<SkillInstructionDepTable>;

export interface SkillExecutionTable {
  id: string;
  skill_id: string;
  conversation_id: string;
  had_tool_errors: number;
  tool_error_details: string | null;
  implicated_instruction_id: string | null;
  success: number | null;
  feedback_notes: string | null;
  created_at: Generated<string>;
}

export type SkillExecution = Selectable<SkillExecutionTable>;
export type NewSkillExecution = Insertable<SkillExecutionTable>;
