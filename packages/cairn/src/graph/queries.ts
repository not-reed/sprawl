import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { nanoid } from 'nanoid'
import type { CairnDatabase } from '../db/types.js'
import type { GraphNode, GraphEdge } from '../types.js'
import { cosineSimilarity } from '../embeddings.js'

// See db/queries.ts for rationale on AnyDB vs DB pattern.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDB = Kysely<any>
type DB = Kysely<CairnDatabase>
const typed = (db: AnyDB): DB => db as DB

// --- Nodes ---

/**
 * Upsert a graph node. If a node with the same canonical name + type exists,
 * update its description (if provided) and updated_at. Otherwise create it.
 * Returns the node (existing or new).
 */
export async function upsertNode(
  db: AnyDB,
  node: {
    name: string
    type: string
    description?: string | null
    embedding?: string | null
  },
): Promise<GraphNode> {
  const d = typed(db)
  const canonicalName = node.name.toLowerCase().trim()
  const displayName = node.name.trim()

  // Check for existing node
  const existing = await d
    .selectFrom('graph_nodes')
    .selectAll()
    .where('name', '=', canonicalName)
    .where('node_type', '=', node.type)
    .executeTakeFirst()

  if (existing) {
    // Update description if a new one is provided and the existing one is empty
    if (node.description && !existing.description) {
      await d
        .updateTable('graph_nodes')
        .set({
          description: node.description,
          ...(node.embedding != null ? { embedding: node.embedding } : {}),
          updated_at: sql<string>`datetime('now')`,
        })
        .where('id', '=', existing.id)
        .execute()

      return { ...existing, description: node.description, embedding: node.embedding ?? existing.embedding } as GraphNode
    }
    return existing as GraphNode
  }

  // Create new node
  const id = nanoid()
  await d
    .insertInto('graph_nodes')
    .values({
      id,
      name: canonicalName,
      display_name: displayName,
      node_type: node.type,
      description: node.description ?? null,
      embedding: node.embedding ?? null,
    })
    .execute()

  return d
    .selectFrom('graph_nodes')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow() as Promise<GraphNode>
}

/**
 * Find a node by canonical name (case-insensitive).
 */
export async function findNodeByName(
  db: AnyDB,
  name: string,
  type?: string,
): Promise<GraphNode | undefined> {
  let qb = typed(db)
    .selectFrom('graph_nodes')
    .selectAll()
    .where('name', '=', name.toLowerCase().trim())

  if (type) {
    qb = qb.where('node_type', '=', type)
  }

  return qb.executeTakeFirst() as Promise<GraphNode | undefined>
}

/**
 * Search nodes by name prefix and/or embedding similarity.
 * When queryEmbedding is provided, embedding matches (above threshold) are
 * merged with LIKE results, with embedding matches first.
 */
export async function searchNodes(
  db: AnyDB,
  query: string,
  limit = 10,
  queryEmbedding?: number[],
): Promise<GraphNode[]> {
  const d = typed(db)
  const pattern = `%${query.toLowerCase().trim()}%`
  const likeResults = await d
    .selectFrom('graph_nodes')
    .selectAll()
    .where('name', 'like', pattern)
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .execute()

  if (!queryEmbedding) return likeResults as GraphNode[]

  // Embedding similarity search
  const threshold = 0.3
  const allWithEmbeddings = await d
    .selectFrom('graph_nodes')
    .selectAll()
    .where('embedding', 'is not', null)
    .execute()

  const embeddingMatches = allWithEmbeddings
    .map((n) => ({
      ...n,
      score: cosineSimilarity(queryEmbedding, JSON.parse(n.embedding!)),
    }))
    .filter((n) => n.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  // Merge: embedding matches first, then LIKE results, deduplicated
  const seen = new Set<string>()
  const merged: GraphNode[] = []
  for (const node of [...embeddingMatches, ...likeResults]) {
    if (!seen.has(node.id) && merged.length < limit) {
      seen.add(node.id)
      const { score, ...graphNode } = node as GraphNode & { score?: number }
      merged.push(graphNode)
    }
  }

  return merged
}

// --- Edges ---

/**
 * Upsert an edge between two nodes. If the edge already exists (same source,
 * target, relation), increment its weight. Otherwise create it.
 */
export async function upsertEdge(
  db: AnyDB,
  edge: {
    source_id: string
    target_id: string
    relation: string
    memory_id?: string | null
    properties?: Record<string, unknown> | null
  },
): Promise<GraphEdge> {
  const d = typed(db)
  const existing = await d
    .selectFrom('graph_edges')
    .selectAll()
    .where('source_id', '=', edge.source_id)
    .where('target_id', '=', edge.target_id)
    .where('relation', '=', edge.relation)
    .executeTakeFirst()

  if (existing) {
    // Increment weight on repeated mention
    await d
      .updateTable('graph_edges')
      .set({
        weight: sql<number>`weight + 1`,
        updated_at: sql<string>`datetime('now')`,
      })
      .where('id', '=', existing.id)
      .execute()

    return { ...existing, weight: existing.weight + 1 } as GraphEdge
  }

  const id = nanoid()
  await d
    .insertInto('graph_edges')
    .values({
      id,
      source_id: edge.source_id,
      target_id: edge.target_id,
      relation: edge.relation,
      properties: edge.properties ? JSON.stringify(edge.properties) : null,
      memory_id: edge.memory_id ?? null,
    })
    .execute()

  return d
    .selectFrom('graph_edges')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow() as Promise<GraphEdge>
}

/**
 * Get all edges connected to a node (as source or target).
 */
export async function getNodeEdges(
  db: AnyDB,
  nodeId: string,
): Promise<GraphEdge[]> {
  return typed(db)
    .selectFrom('graph_edges')
    .selectAll()
    .where((eb) =>
      eb.or([
        eb('source_id', '=', nodeId),
        eb('target_id', '=', nodeId),
      ]),
    )
    .orderBy('weight', 'desc')
    .execute() as Promise<GraphEdge[]>
}

/**
 * Traverse the graph from a starting node using recursive CTE.
 * Returns all reachable nodes within `maxDepth` hops, with their
 * shortest distance from the start.
 */
export async function traverseGraph(
  db: AnyDB,
  startNodeId: string,
  maxDepth = 2,
): Promise<Array<{ node: GraphNode; depth: number; via_relation: string | null }>> {
  const results = await sql<{
    id: string
    name: string
    display_name: string
    node_type: string
    description: string | null
    embedding: string | null
    created_at: string
    updated_at: string
    depth: number
    via_relation: string | null
  }>`
    WITH RECURSIVE traverse(node_id, depth, via_relation, visited) AS (
      SELECT ${startNodeId}, 0, NULL, ${startNodeId}
      UNION ALL
      SELECT
        CASE
          WHEN e.source_id = t.node_id THEN e.target_id
          ELSE e.source_id
        END,
        t.depth + 1,
        e.relation,
        t.visited || ',' ||
          CASE
            WHEN e.source_id = t.node_id THEN e.target_id
            ELSE e.source_id
          END
      FROM traverse t
      JOIN graph_edges e ON (e.source_id = t.node_id OR e.target_id = t.node_id)
      WHERE t.depth < ${maxDepth}
        AND t.visited NOT LIKE '%' ||
          CASE
            WHEN e.source_id = t.node_id THEN e.target_id
            ELSE e.source_id
          END || '%'
    )
    SELECT DISTINCT
      n.*,
      t.depth,
      t.via_relation
    FROM traverse t
    JOIN graph_nodes n ON n.id = t.node_id
    WHERE t.depth > 0
    ORDER BY t.depth ASC
  `.execute(db)

  return results.rows.map((row) => ({
    node: {
      id: row.id,
      name: row.name,
      display_name: row.display_name,
      node_type: row.node_type,
      description: row.description,
      embedding: row.embedding,
      created_at: row.created_at,
      updated_at: row.updated_at,
    } as GraphNode,
    depth: row.depth,
    via_relation: row.via_relation,
  }))
}

/**
 * Find memories connected to a set of nodes via edges.
 * Returns unique memory IDs from all edges connected to the given nodes.
 */
export async function getRelatedMemoryIds(
  db: AnyDB,
  nodeIds: string[],
): Promise<string[]> {
  if (nodeIds.length === 0) return []

  const results = await typed(db)
    .selectFrom('graph_edges')
    .select('memory_id')
    .distinct()
    .where('memory_id', 'is not', null)
    .where((eb) =>
      eb.or([
        eb('source_id', 'in', nodeIds),
        eb('target_id', 'in', nodeIds),
      ]),
    )
    .execute()

  return results.map((r) => r.memory_id!).filter(Boolean)
}

/**
 * Get all nodes connected to a specific memory via edges.
 */
export async function getMemoryNodes(
  db: AnyDB,
  memoryId: string,
): Promise<GraphNode[]> {
  const d = typed(db)
  const edges = await d
    .selectFrom('graph_edges')
    .select(['source_id', 'target_id'])
    .where('memory_id', '=', memoryId)
    .execute()

  const nodeIds = new Set<string>()
  for (const edge of edges) {
    nodeIds.add(edge.source_id)
    nodeIds.add(edge.target_id)
  }

  if (nodeIds.size === 0) return []

  return d
    .selectFrom('graph_nodes')
    .selectAll()
    .where('id', 'in', [...nodeIds])
    .execute() as Promise<GraphNode[]>
}
