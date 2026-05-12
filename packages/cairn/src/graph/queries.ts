import type { Kysely } from "kysely";
import { sql } from "kysely";
import { nanoid } from "nanoid";
import type { CairnDatabase } from "../db/types.js";
import type { GraphNode, GraphEdge } from "../types.js";
import { cosineSimilarity } from "../embeddings.js";
import { SIMILARITY } from "../similarity.js";

// See db/queries.ts for rationale on AnyDB vs DB pattern.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDB = Kysely<any>;
type DB = Kysely<CairnDatabase>;
const typed = (db: AnyDB): DB => db as DB;

// --- Nodes ---

/**
 * Upsert a graph node. If a node with the same canonical name + type exists,
 * update its description (if provided) and updated_at. Otherwise create it.
 * Returns the node (existing or new).
 */
export async function upsertNode(
  db: AnyDB,
  node: {
    name: string;
    type: string;
    description?: string | null;
    embedding?: string | null;
  },
): Promise<GraphNode> {
  const d = typed(db);
  const canonicalName = node.name.toLowerCase().trim();
  const displayName = node.name.trim();

  // Check for existing node
  const existing = await d
    .selectFrom("graph_nodes")
    .selectAll()
    .where("name", "=", canonicalName)
    .where("node_type", "=", node.type)
    .executeTakeFirst();

  if (existing) {
    // Update description if a new one is provided and the existing one is empty
    if (node.description && !existing.description) {
      await d
        .updateTable("graph_nodes")
        .set({
          description: node.description,
          ...(node.embedding != null ? { embedding: node.embedding } : {}),
          updated_at: sql<string>`datetime('now')`,
        })
        .where("id", "=", existing.id)
        .execute();

      return {
        ...existing,
        description: node.description,
        embedding: node.embedding ?? existing.embedding,
      } as GraphNode;
    }
    return existing as GraphNode;
  }

  // Create new node
  const id = nanoid();
  await d
    .insertInto("graph_nodes")
    .values({
      id,
      name: canonicalName,
      display_name: displayName,
      node_type: node.type,
      description: node.description ?? null,
      embedding: node.embedding ?? null,
    })
    .execute();

  return d
    .selectFrom("graph_nodes")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow() as Promise<GraphNode>;
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
    .selectFrom("graph_nodes")
    .selectAll()
    .where("name", "=", name.toLowerCase().trim());

  if (type) {
    qb = qb.where("node_type", "=", type);
  }

  return qb.executeTakeFirst() as Promise<GraphNode | undefined>;
}

/**
 * Search nodes by name substring (LIKE) and/or embedding cosine similarity.
 * When queryEmbedding is provided, embedding matches above GRAPH_SEARCH threshold
 * are merged with LIKE results, embedding matches ranked first.
 * @param query - Name substring to search (case-insensitive).
 * @param queryEmbedding - Optional pre-computed embedding for semantic search.
 */
export async function searchNodes(
  db: AnyDB,
  query: string,
  limit = 10,
  queryEmbedding?: number[],
): Promise<GraphNode[]> {
  const d = typed(db);
  const pattern = `%${query.toLowerCase().trim()}%`;
  const likeResults = await d
    .selectFrom("graph_nodes")
    .selectAll()
    .where("name", "like", pattern)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute();

  if (!queryEmbedding) return likeResults as GraphNode[];

  // Embedding similarity search
  const threshold = SIMILARITY.GRAPH_SEARCH;
  const allWithEmbeddings = await d
    .selectFrom("graph_nodes")
    .selectAll()
    .where("embedding", "is not", null)
    .execute();

  const embeddingMatches = allWithEmbeddings
    .map((n) => ({
      ...n,
      score: cosineSimilarity(queryEmbedding, JSON.parse(n.embedding!)),
    }))
    .filter((n) => n.score >= threshold)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit);

  // Merge: embedding matches first, then LIKE results, deduplicated
  const seen = new Set<string>();
  const merged: GraphNode[] = [];
  for (const node of [...embeddingMatches, ...likeResults]) {
    if (!seen.has(node.id) && merged.length < limit) {
      seen.add(node.id);
      const { score: _score, ...graphNode } = node as GraphNode & { score?: number };
      merged.push(graphNode);
    }
  }

  return merged;
}

/**
 * Like searchNodes but returns similarity scores for use as spreading activation seeds.
 * LIKE-only matches get a default score of 0.5.
 */
export async function searchNodesWithScores(
  db: AnyDB,
  query: string,
  limit = 10,
  queryEmbedding?: number[],
): Promise<Array<{ node: GraphNode; score: number }>> {
  const d = typed(db);
  const pattern = `%${query.toLowerCase().trim()}%`;
  const likeResults = await d
    .selectFrom("graph_nodes")
    .selectAll()
    .where("name", "like", pattern)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute();

  if (!queryEmbedding) {
    return (likeResults as GraphNode[]).map((n) => ({ node: n, score: 0.5 }));
  }

  const threshold = SIMILARITY.GRAPH_SEARCH;
  const allWithEmbeddings = await d
    .selectFrom("graph_nodes")
    .selectAll()
    .where("embedding", "is not", null)
    .execute();

  const embeddingMatches = allWithEmbeddings
    .map((n) => ({
      node: n as GraphNode,
      score: cosineSimilarity(queryEmbedding, JSON.parse(n.embedding!)),
    }))
    .filter((n) => n.score >= threshold)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit);

  const seen = new Set<string>();
  const merged: Array<{ node: GraphNode; score: number }> = [];
  for (const item of embeddingMatches) {
    if (!seen.has(item.node.id) && merged.length < limit) {
      seen.add(item.node.id);
      merged.push(item);
    }
  }
  for (const node of likeResults) {
    if (!seen.has(node.id) && merged.length < limit) {
      seen.add(node.id);
      merged.push({ node: node as GraphNode, score: 0.5 });
    }
  }

  return merged;
}

// --- Edges ---

/**
 * Upsert an edge between two nodes. If the edge already exists (same source,
 * target, relation), increment its weight. Otherwise create it.
 */
export async function upsertEdge(
  db: AnyDB,
  edge: {
    source_id: string;
    target_id: string;
    relation: string;
    memory_id?: string | null;
    properties?: Record<string, unknown> | null;
  },
): Promise<GraphEdge> {
  const d = typed(db);
  const existing = await d
    .selectFrom("graph_edges")
    .selectAll()
    .where("source_id", "=", edge.source_id)
    .where("target_id", "=", edge.target_id)
    .where("relation", "=", edge.relation)
    .executeTakeFirst();

  if (existing) {
    // Increment weight on repeated mention
    await d
      .updateTable("graph_edges")
      .set({
        weight: sql<number>`weight + 1`,
        updated_at: sql<string>`datetime('now')`,
      })
      .where("id", "=", existing.id)
      .execute();

    return { ...existing, weight: existing.weight + 1 } as GraphEdge;
  }

  const id = nanoid();
  await d
    .insertInto("graph_edges")
    .values({
      id,
      source_id: edge.source_id,
      target_id: edge.target_id,
      relation: edge.relation,
      properties: edge.properties ? JSON.stringify(edge.properties) : null,
      memory_id: edge.memory_id ?? null,
    })
    .execute();

  return d
    .selectFrom("graph_edges")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow() as Promise<GraphEdge>;
}

/**
 * Get all edges connected to a node (as source or target).
 */
export async function getNodeEdges(db: AnyDB, nodeId: string): Promise<GraphEdge[]> {
  return typed(db)
    .selectFrom("graph_edges")
    .selectAll()
    .where((eb) => eb.or([eb("source_id", "=", nodeId), eb("target_id", "=", nodeId)]))
    .orderBy("weight", "desc")
    .execute() as Promise<GraphEdge[]>;
}

export { traverseGraph, spreadActivation } from "./traversal.js";

/**
 * Get all edges connected to any of the given nodes (batched).
 */
export async function getEdgesForNodes(db: AnyDB, nodeIds: string[]): Promise<GraphEdge[]> {
  if (nodeIds.length === 0) return [];
  return typed(db)
    .selectFrom("graph_edges")
    .selectAll()
    .where((eb) => eb.or([eb("source_id", "in", nodeIds), eb("target_id", "in", nodeIds)]))
    .execute() as Promise<GraphEdge[]>;
}

/**
 * Find memories connected to a set of nodes via edges.
 * Returns unique memory IDs from all edges connected to the given nodes.
 */
export async function getRelatedMemoryIds(db: AnyDB, nodeIds: string[]): Promise<string[]> {
  if (nodeIds.length === 0) return [];

  const results = await typed(db)
    .selectFrom("graph_edges")
    .select("memory_id")
    .distinct()
    .where("memory_id", "is not", null)
    .where((eb) => eb.or([eb("source_id", "in", nodeIds), eb("target_id", "in", nodeIds)]))
    .execute();

  return results.map((r) => r.memory_id!).filter(Boolean);
}

/**
 * Find memories connected to scored nodes and assign each memory the
 * best activation score from its linked nodes.
 * Use after spreadActivation to rank graph-expanded memories.
 * @param nodeScoreMap - Map of node ID → activation score (from seeds + spread results).
 * @returns Scored memory IDs sorted by score descending.
 */
export async function getRelatedMemoriesWithScores(
  db: AnyDB,
  nodeScoreMap: Map<string, number>,
): Promise<Array<{ memoryId: string; score: number }>> {
  const nodeIds = [...nodeScoreMap.keys()];
  if (nodeIds.length === 0) return [];

  const edges = await typed(db)
    .selectFrom("graph_edges")
    .select(["source_id", "target_id", "memory_id"])
    .where("memory_id", "is not", null)
    .where((eb) => eb.or([eb("source_id", "in", nodeIds), eb("target_id", "in", nodeIds)]))
    .execute();

  // For each memory, take the max score from any connected scored node
  const memoryScores = new Map<string, number>();
  for (const edge of edges) {
    const memId = edge.memory_id!;
    const sourceScore = nodeScoreMap.get(edge.source_id) ?? 0;
    const targetScore = nodeScoreMap.get(edge.target_id) ?? 0;
    const best = Math.max(sourceScore, targetScore);
    const current = memoryScores.get(memId) ?? 0;
    if (best > current) {
      memoryScores.set(memId, best);
    }
  }

  return [...memoryScores.entries()]
    .map(([memoryId, score]) => ({ memoryId, score }))
    .toSorted((a, b) => b.score - a.score);
}

/**
 * Get all nodes connected to a specific memory via edges.
 */
export async function getMemoryNodes(db: AnyDB, memoryId: string): Promise<GraphNode[]> {
  const d = typed(db);
  const edges = await d
    .selectFrom("graph_edges")
    .select(["source_id", "target_id"])
    .where("memory_id", "=", memoryId)
    .execute();

  const nodeIds = new Set<string>();
  for (const edge of edges) {
    nodeIds.add(edge.source_id);
    nodeIds.add(edge.target_id);
  }

  if (nodeIds.size === 0) return [];

  return d
    .selectFrom("graph_nodes")
    .selectAll()
    .where("id", "in", [...nodeIds])
    .execute() as Promise<GraphNode[]>;
}
