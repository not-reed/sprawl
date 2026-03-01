import type { Generated, Insertable, Selectable, Updateable } from 'kysely'

/**
 * Tables that Cairn requires. Consumers extend this interface with their own tables.
 * Example: `interface Database extends CairnDatabase { schedules: ScheduleTable; ... }`
 *
 * Cairn does NOT own migrations — each consumer manages its own.
 */
export interface CairnDatabase {
  memories: MemoryTable
  conversations: ConversationTable
  messages: MessageTable
  ai_usage: AiUsageTable
  graph_nodes: GraphNodeTable
  graph_edges: GraphEdgeTable
  observations: ObservationTable
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
  observed_up_to_message_id: string | null
  observation_token_count: Generated<number>
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
  telegram_message_id: number | null
  created_at: Generated<string>
}

export type Message = Selectable<MessageTable>
export type NewMessage = Insertable<MessageTable>

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

export interface GraphNodeTable {
  id: string
  name: string
  display_name: string
  node_type: Generated<string>
  description: string | null
  embedding: string | null
  created_at: Generated<string>
  updated_at: Generated<string>
}

export type GraphNode = Selectable<GraphNodeTable>
export type NewGraphNode = Insertable<GraphNodeTable>

export interface GraphEdgeTable {
  id: string
  source_id: string
  target_id: string
  relation: string
  weight: Generated<number>
  properties: string | null
  memory_id: string | null
  created_at: Generated<string>
  updated_at: Generated<string>
}

export type GraphEdge = Selectable<GraphEdgeTable>
export type NewGraphEdge = Insertable<GraphEdgeTable>

export interface ObservationTable {
  id: string
  conversation_id: string
  content: string
  priority: Generated<string>
  observation_date: string
  source_message_ids: string | null
  token_count: number | null
  generation: Generated<number>
  superseded_at: string | null
  promoted_at: string | null
  created_at: Generated<string>
}

export type Observation = Selectable<ObservationTable>
export type NewObservation = Insertable<ObservationTable>
