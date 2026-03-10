import type { Kysely } from "kysely";
import type { WorkerModelConfig, ExtractionResult, CairnLogger } from "../types.js";
import { extractEntities } from "./extract.js";
import {
  upsertNode,
  upsertEdge,
  findNodeByName,
  searchNodes,
  traverseGraph,
  getNodeEdges,
  getRelatedMemoryIds,
  getMemoryNodes,
} from "./queries.js";
import { generateEmbedding } from "../embeddings.js";

export {
  findNodeByName,
  searchNodes,
  traverseGraph,
  getNodeEdges,
  getRelatedMemoryIds,
  getMemoryNodes,
};

/**
 * Process a stored memory: extract entities/relationships via LLM and upsert into the graph.
 * Generates embeddings for new nodes if apiKey is provided in embeddingOpts.
 * Designed to be called async after memory storage.
 * @param db - Database handle.
 * @param config - Worker model config for entity extraction LLM call.
 * @param memoryId - ID of the source memory (linked to edges).
 * @param content - Memory text to extract entities from.
 * @param embeddingOpts - If provided, generates embeddings for upserted graph nodes.
 * @param entityTypes - Allowed entity types (defaults to person, place, concept, event, entity).
 * @returns Extraction result with entities, relationships, and token usage.
 */
export async function processMemoryForGraph(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely invariance, see db/queries.ts
  db: Kysely<any>,
  config: WorkerModelConfig,
  memoryId: string,
  content: string,
  embeddingOpts?: { apiKey?: string; embeddingModel?: string },
  logger?: CairnLogger,
  entityTypes?: string[],
): Promise<ExtractionResult> {
  const result = await extractEntities(config, content, logger, entityTypes);

  if (result.entities.length === 0 && result.relationships.length === 0) {
    logger?.debug(`No graph entities extracted from memory [${memoryId}]`);
    return result;
  }

  // Upsert all entities as nodes
  const nodeMap = new Map<string, string>(); // name (lowered) → node id
  for (const entity of result.entities) {
    const node = await upsertNode(db, {
      name: entity.name,
      type: entity.type,
      description: entity.description,
    });
    nodeMap.set(entity.name.toLowerCase().trim(), node.id);
  }

  // Generate embeddings for all upserted nodes in parallel
  if (embeddingOpts?.apiKey) {
    const nodeEntries = [...nodeMap.entries()];
    const embeddingResults = await Promise.allSettled(
      nodeEntries.map(async ([nameKey, nodeId]) => {
        const entity = result.entities.find((e) => e.name.toLowerCase().trim() === nameKey);
        const text = entity?.description
          ? `${entity.name}: ${entity.description}`
          : (entity?.name ?? nameKey);
        const embedding = await generateEmbedding(
          embeddingOpts.apiKey!,
          text,
          embeddingOpts.embeddingModel,
        );
        await db
          .updateTable("graph_nodes")
          .set({ embedding: JSON.stringify(embedding) })
          .where("id", "=", nodeId)
          .execute();
      }),
    );

    const failed = embeddingResults.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      logger?.warning(
        `Failed to generate embeddings for ${failed.length}/${nodeEntries.length} nodes`,
      );
    }
  }

  // Upsert relationships as edges
  for (const rel of result.relationships) {
    const sourceKey = rel.from.toLowerCase().trim();
    const targetKey = rel.to.toLowerCase().trim();

    let sourceId = nodeMap.get(sourceKey);
    let targetId = nodeMap.get(targetKey);

    // If a relationship references an entity not in the extraction,
    // try to find it in the existing graph or create it as generic entity
    if (!sourceId) {
      const existing = await findNodeByName(db, rel.from);
      if (existing) {
        sourceId = existing.id;
      } else {
        const node = await upsertNode(db, { name: rel.from, type: "entity" });
        sourceId = node.id;
      }
      nodeMap.set(sourceKey, sourceId);
    }

    if (!targetId) {
      const existing = await findNodeByName(db, rel.to);
      if (existing) {
        targetId = existing.id;
      } else {
        const node = await upsertNode(db, { name: rel.to, type: "entity" });
        targetId = node.id;
      }
      nodeMap.set(targetKey, targetId);
    }

    await upsertEdge(db, {
      source_id: sourceId,
      target_id: targetId,
      relation: rel.relation.toLowerCase(),
      memory_id: memoryId,
    });
  }

  logger?.info(
    `Graph: extracted ${result.entities.length} entities, ${result.relationships.length} relationships from memory [${memoryId}]`,
  );
  return result;
}
