import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { WorkerModelConfig, ExtractionResult } from '../types.js'
import { extractEntities } from './extract.js'
import {
  upsertNode,
  upsertEdge,
  findNodeByName,
  searchNodes,
  traverseGraph,
  getNodeEdges,
  getRelatedMemoryIds,
  getMemoryNodes,
} from './queries.js'
import { toolLog } from '../../logger.js'

export { findNodeByName, searchNodes, traverseGraph, getNodeEdges, getRelatedMemoryIds, getMemoryNodes }

/**
 * Process a stored memory: extract entities/relationships and upsert them into the graph.
 * Designed to be called async after memory storage — non-blocking.
 * Returns the extraction result for usage tracking.
 */
export async function processMemoryForGraph(
  db: Kysely<Database>,
  config: WorkerModelConfig,
  memoryId: string,
  content: string,
): Promise<ExtractionResult> {
  const result = await extractEntities(config, content)

  if (result.entities.length === 0 && result.relationships.length === 0) {
    toolLog.debug`No graph entities extracted from memory [${memoryId}]`
    return result
  }

  // Upsert all entities as nodes
  const nodeMap = new Map<string, string>() // name (lowered) → node id
  for (const entity of result.entities) {
    const node = await upsertNode(db, {
      name: entity.name,
      type: entity.type,
      description: entity.description,
    })
    nodeMap.set(entity.name.toLowerCase().trim(), node.id)
  }

  // Upsert relationships as edges
  for (const rel of result.relationships) {
    const sourceKey = rel.from.toLowerCase().trim()
    const targetKey = rel.to.toLowerCase().trim()

    let sourceId = nodeMap.get(sourceKey)
    let targetId = nodeMap.get(targetKey)

    // If a relationship references an entity not in the extraction,
    // try to find it in the existing graph or create it as generic entity
    if (!sourceId) {
      const existing = await findNodeByName(db, rel.from)
      if (existing) {
        sourceId = existing.id
      } else {
        const node = await upsertNode(db, { name: rel.from, type: 'entity' })
        sourceId = node.id
      }
      nodeMap.set(sourceKey, sourceId)
    }

    if (!targetId) {
      const existing = await findNodeByName(db, rel.to)
      if (existing) {
        targetId = existing.id
      } else {
        const node = await upsertNode(db, { name: rel.to, type: 'entity' })
        targetId = node.id
      }
      nodeMap.set(targetKey, targetId)
    }

    await upsertEdge(db, {
      source_id: sourceId,
      target_id: targetId,
      relation: rel.relation.toLowerCase(),
      memory_id: memoryId,
    })
  }

  toolLog.info`Graph: extracted ${result.entities.length} entities, ${result.relationships.length} relationships from memory [${memoryId}]`
  return result
}
