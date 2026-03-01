/**
 * Shared types for the Cairn memory system.
 * Used by Observational Memory, Graph Memory, and consumers.
 */

// --- Observational Memory ---

export interface Observation {
  id: string
  conversation_id: string
  content: string
  priority: 'low' | 'medium' | 'high'
  observation_date: string
  source_message_ids: string[] // parsed from JSON
  token_count: number
  generation: number // 0=observer, 1+=reflector rounds
  superseded_at: string | null
  created_at: string
}

export interface ObserverInput {
  messages: Array<{
    role: string
    content: string
    created_at: string
    telegram_message_id?: number | null
  }>
}

export interface ObserverOutput {
  observations: Array<{
    content: string
    priority: 'low' | 'medium' | 'high'
    observation_date: string
  }>
}

export interface ReflectorInput {
  observations: Observation[]
}

export interface ReflectorOutput {
  observations: Array<{
    content: string
    priority: 'low' | 'medium' | 'high'
    observation_date: string
  }>
  superseded_ids: string[]
}

// --- Graph Memory ---

export interface GraphNode {
  id: string
  name: string // canonical (lowercased)
  display_name: string // original casing
  node_type: 'person' | 'place' | 'concept' | 'event' | 'entity'
  description: string | null
  embedding: string | null
  created_at: string
  updated_at: string
}

export interface GraphEdge {
  id: string
  source_id: string
  target_id: string
  relation: string
  weight: number
  properties: Record<string, unknown> | null
  memory_id: string | null
  created_at: string
  updated_at: string
}

export interface ExtractedEntity {
  name: string
  type: GraphNode['node_type']
  description?: string
}

export interface ExtractedRelationship {
  from: string
  to: string
  relation: string
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  relationships: ExtractedRelationship[]
  usage?: { input_tokens: number; output_tokens: number }
}

// --- Context Building ---

export interface ContextWindow {
  observations: string // rendered observation prefix
  activeMessages: Array<{
    role: string
    content: string
    telegram_message_id?: number | null
  }>
}

// --- Worker Model ---

export interface WorkerModelConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

// --- Logger (dependency injection) ---

export interface CairnLogger {
  info(msg: string): void
  warning(msg: string): void
  error(msg: string): void
  debug(msg: string): void
}

/** No-op logger used as default */
export const nullLogger: CairnLogger = {
  info() {},
  warning() {},
  error() {},
  debug() {},
}
