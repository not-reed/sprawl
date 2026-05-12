import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { CairnDatabase } from "../db/types.js";
import type { GraphNode } from "../types.js";
import { getEdgesForNodes } from "./queries.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDB = Kysely<any>;
type DB = Kysely<CairnDatabase>;
const typed = (db: AnyDB): DB => db as DB;

/**
 * Traverse the graph from a starting node using a recursive CTE.
 * Follows edges bidirectionally, avoiding cycles via visited-path tracking.
 * @param startNodeId - Node to begin traversal from (excluded from results).
 * @param maxDepth - Maximum hops from start (default 2).
 * @returns Reachable nodes with their hop distance and the edge relation that reached them.
 */
export async function traverseGraph(
  db: AnyDB,
  startNodeId: string,
  maxDepth = 2,
): Promise<Array<{ node: GraphNode; depth: number; via_relation: string | null }>> {
  const results = await sql<{
    id: string;
    name: string;
    display_name: string;
    node_type: string;
    description: string | null;
    embedding: string | null;
    created_at: string;
    updated_at: string;
    depth: number;
    via_relation: string | null;
  }>`
    WITH RECURSIVE traverse(node_id, depth, via_relation, visited) AS (
      SELECT ${sql.val(startNodeId)}, 0, NULL, ${sql.val(startNodeId)}
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
      WHERE t.depth < ${sql.val(maxDepth)}
        AND ',' || t.visited || ',' NOT LIKE '%,' ||
          CASE
            WHEN e.source_id = t.node_id THEN e.target_id
            ELSE e.source_id
          END || ',%'
    )
    SELECT DISTINCT
      n.*,
      t.depth,
      t.via_relation
    FROM traverse t
    JOIN graph_nodes n ON n.id = t.node_id
    WHERE t.depth > 0
    ORDER BY t.depth ASC
  `.execute(db);

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
  }));
}

interface ActivationEntry {
  score: number;
  depth: number;
}

interface ExpandArgs {
  frontier: Array<{ nodeId: string; score: number; depth: number }>;
  edges: Array<{ source_id: string; target_id: string; weight: number }>;
  decay: number;
  minActivation: number;
  activation: Map<string, ActivationEntry>;
  hop: number;
}

function expandFrontier(args: ExpandArgs): Array<{ nodeId: string; score: number; depth: number }> {
  const { frontier, edges, decay, minActivation, activation, hop } = args;
  const next: typeof frontier = [];
  for (const current of frontier) {
    for (const edge of edges.filter(
      (e) => e.source_id === current.nodeId || e.target_id === current.nodeId,
    )) {
      const neighborId = edge.source_id === current.nodeId ? edge.target_id : edge.source_id;
      const weightBoost = Math.min(edge.weight, 10) / 10;
      const effectiveDecay = decay + (1 - decay) * weightBoost;
      const neighborScore = current.score * effectiveDecay;

      if (neighborScore < minActivation) continue;

      const existing = activation.get(neighborId);
      if (!existing || neighborScore > existing.score) {
        activation.set(neighborId, { score: neighborScore, depth: hop + 1 });
        next.push({ nodeId: neighborId, score: neighborScore, depth: hop + 1 });
      }
    }
  }
  return next;
}

/**
 * Spreading activation: BFS from seed nodes with exponential score decay.
 * Each hop reduces activation by `decay * edgeWeight`. Nodes reached via
 * multiple paths accumulate the max activation (not sum — avoids inflation).
 */
export async function spreadActivation(
  db: AnyDB,
  seeds: Array<{ nodeId: string; score: number }>,
  opts?: { decay?: number; maxDepth?: number; minActivation?: number },
): Promise<Array<{ node: GraphNode; score: number; depth: number }>> {
  const decay = opts?.decay ?? 0.5;
  const maxDepth = opts?.maxDepth ?? 2;
  const minActivation = opts?.minActivation ?? 0.01;

  const activation = new Map<string, ActivationEntry>();
  for (const seed of seeds) {
    const existing = activation.get(seed.nodeId);
    if (!existing || seed.score > existing.score) {
      activation.set(seed.nodeId, { score: seed.score, depth: 0 });
    }
  }

  let frontier = seeds.map((s) => ({ nodeId: s.nodeId, score: s.score, depth: 0 }));

  for (let hop = 0; hop < maxDepth; hop++) {
    const nodeIds = frontier.map((f) => f.nodeId);
    const allEdges = await getEdgesForNodes(db, nodeIds);
    frontier = expandFrontier({
      frontier,
      edges: allEdges,
      decay,
      minActivation,
      activation,
      hop,
    });
    if (frontier.length === 0) break;
  }

  const seedIds = new Set(seeds.map((s) => s.nodeId));
  const resultIds = [...activation.entries()]
    .filter(([id]) => !seedIds.has(id))
    .filter(([, a]) => a.score >= minActivation)
    .toSorted(([, a], [, b]) => b.score - a.score);

  if (resultIds.length === 0) return [];

  const nodeIds = resultIds.map(([id]) => id);
  const nodes = await typed(db)
    .selectFrom("graph_nodes")
    .selectAll()
    .where("id", "in", nodeIds)
    .execute();

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return resultIds
    .map(([id, a]) => {
      const node = nodeMap.get(id);
      if (!node) return null;
      return { node: node as GraphNode, score: a.score, depth: a.depth };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}
