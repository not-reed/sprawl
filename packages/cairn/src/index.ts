// Cairn — reusable memory system
// Main entry point / barrel export

export { MemoryManager, OBSERVER_THRESHOLD, REFLECTOR_THRESHOLD, OBSERVER_MAX_BATCH_TOKENS } from './manager.js'
export type { CairnOptions } from './manager.js'

// Types
export type {
  Observation,
  ObserverInput,
  ObserverOutput,
  ReflectorInput,
  ReflectorOutput,
  GraphNode,
  GraphEdge,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractionResult,
  CairnMessage,
  ContextWindow,
  WorkerModelConfig,
  CairnLogger,
} from './types.js'
export { nullLogger } from './types.js'

// Context rendering
export {
  renderObservations,
  renderObservationsWithBudget,
  buildContextWindow,
  OBSERVATION_BUDGET,
} from './context.js'
export type { BudgetedObservations } from './context.js'

// Token estimation
export { estimateTokens, estimateMessageTokens } from './tokens.js'

// Embeddings
export { generateEmbedding, cosineSimilarity } from './embeddings.js'

// Similarity thresholds
export { SIMILARITY } from './similarity.js'

// Graph (re-export from submodule)
export { processMemoryForGraph } from './graph/index.js'
export { extractEntities, DEFAULT_ENTITY_TYPES } from './graph/extract.js'
export {
  searchNodes,
  traverseGraph,
  getNodeEdges,
  getRelatedMemoryIds,
  getMemoryNodes,
  findNodeByName,
  upsertNode,
  upsertEdge,
} from './graph/queries.js'

// DB types (for consumers extending the schema)
export type {
  CairnDatabase,
  MemoryTable,
  Memory,
  NewMemory,
  MemoryUpdate,
  ConversationTable,
  Conversation,
  NewConversation,
  MessageTable,
  Message,
  NewMessage,
  AiUsageTable,
  AiUsage,
  NewAiUsage,
  GraphNodeTable,
  NewGraphNode,
  GraphEdgeTable,
  NewGraphEdge,
  ObservationTable,
  NewObservation,
} from './db/types.js'

// DB queries
export {
  storeMemory,
  updateMemoryEmbedding,
  recallMemories,
  getRecentMemories,
  forgetMemory,
  searchMemoriesForForget,
  trackUsage,
} from './db/queries.js'

// Observer / Reflector (for direct use / backfill)
export { observe, isDegenerateRaw, sanitizeObservations, DEFAULT_OBSERVER_PROMPT } from './observer.js'
export { reflect, validateSupersededIds, DEFAULT_REFLECTOR_PROMPT } from './reflector.js'
