import type { Generated, Insertable, Selectable, Updateable } from 'kysely'

export interface Database {
  memories: MemoryTable
  conversations: ConversationTable
  messages: MessageTable
  schedules: ScheduleTable
  ai_usage: AiUsageTable
  settings: SettingTable
}

export interface MemoryTable {
  id: string
  content: string
  category: Generated<string>
  tags: string | null
  source: Generated<string>
  embedding: string | null
  created_at: Generated<string>
  updated_at: Generated<string>
  archived_at: string | null
}

export type Memory = Selectable<MemoryTable>
export type NewMemory = Insertable<MemoryTable>
export type MemoryUpdate = Updateable<MemoryTable>

export interface ConversationTable {
  id: string
  source: string
  external_id: string | null
  created_at: Generated<string>
  updated_at: Generated<string>
}

export type Conversation = Selectable<ConversationTable>
export type NewConversation = Insertable<ConversationTable>

export interface MessageTable {
  id: string
  conversation_id: string
  role: string
  content: string
  tool_calls: string | null
  created_at: Generated<string>
}

export type Message = Selectable<MessageTable>
export type NewMessage = Insertable<MessageTable>

export interface ScheduleTable {
  id: string
  description: string
  cron_expression: string | null
  run_at: string | null
  message: string
  chat_id: string
  active: Generated<number>
  last_run_at: string | null
  created_at: Generated<string>
}

export type Schedule = Selectable<ScheduleTable>
export type NewSchedule = Insertable<ScheduleTable>
export type ScheduleUpdate = Updateable<ScheduleTable>

export interface AiUsageTable {
  id: string
  model: string
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  source: string
  created_at: Generated<string>
}

export type AiUsage = Selectable<AiUsageTable>
export type NewAiUsage = Insertable<AiUsageTable>

export interface SettingTable {
  key: string
  value: string
  updated_at: Generated<string>
}

export type Setting = Selectable<SettingTable>
