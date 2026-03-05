import type { Generated, Insertable, Selectable, Updateable } from 'kysely'
import type { CairnDatabase } from '@repo/cairn'

// Index signature needed so Kysely<Database> is assignable to cairn's
// Kysely<CairnDatabase & Record<string, any>> (Kysely is invariant).
export interface Database extends CairnDatabase {
  schedules: ScheduleTable
  settings: SettingTable
  secrets: SecretTable
  pending_asks: PendingAskTable
  [key: string]: any  // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface ScheduleTable {
  id: string
  description: string
  cron_expression: string | null
  run_at: string | null
  message: string
  prompt: string | null
  chat_id: string
  active: Generated<number>
  last_run_at: string | null
  created_at: Generated<string>
}

export type Schedule = Selectable<ScheduleTable>
export type NewSchedule = Insertable<ScheduleTable>
export type ScheduleUpdate = Updateable<ScheduleTable>

export interface SettingTable {
  key: string
  value: string
  updated_at: Generated<string>
}

export type Setting = Selectable<SettingTable>

export interface SecretTable {
  key: string
  value: string
  source: Generated<string>
  created_at: Generated<string>
  updated_at: Generated<string>
}

export type Secret = Selectable<SecretTable>

export interface PendingAskTable {
  id: string
  conversation_id: string
  chat_id: string
  question: string
  options: string | null // JSON string[]
  telegram_message_id: number | null
  created_at: Generated<string>
  resolved_at: string | null
  response: string | null
}

export type PendingAsk = Selectable<PendingAskTable>
