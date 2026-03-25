import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import {
  recallMemories,
  generateEmbedding,
  searchNodesWithScores,
  spreadActivation,
  getRelatedMemoriesWithScores,
  type Memory,
} from "@repo/cairn";
import type { Database } from "../../db/schema.js";
import { toolLog } from "../../logger.js";

const MemoryRecallParams = Type.Object({
  query: Type.String({
    description: "Search query — keywords or topic to search for in memories",
  }),
  category: Type.Optional(
    Type.String({
      description: "Filter by category: general, preference, fact, reminder, note",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max number of results to return (default: 10)",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description: "ISO date (YYYY-MM-DD). Only return memories created on or after this date.",
    }),
  ),
  before: Type.Optional(
    Type.String({
      description: "ISO date (YYYY-MM-DD). Only return memories created before this date.",
    }),
  ),
});

type MemoryRecallInput = Static<typeof MemoryRecallParams>;

export function createMemoryRecallTool(
  db: Kysely<Database>,
  apiKey?: string,
  embeddingModel?: string,
) {
  return {
    name: "memory_recall",
    description:
      "Search long-term memories by keyword or topic. Uses full-text search and semantic similarity. Use this when the user asks about something you might have stored, or when you need context from past conversations.",
    parameters: MemoryRecallParams,
    execute: async (_toolCallId: string, args: MemoryRecallInput) => {
      // Generate query embedding for semantic search
      let queryEmbedding: number[] | undefined;
      if (apiKey) {
        try {
          queryEmbedding = await generateEmbedding(apiKey, args.query, embeddingModel);
        } catch (err) {
          toolLog.warning`Failed to generate query embedding, falling back to text search: ${err}`;
        }
      }

      const memories = await recallMemories(db, args.query, {
        category: args.category,
        limit: args.limit,
        queryEmbedding,
        since: args.since,
        before: args.before,
      });

      // Expand via graph spreading activation — find related memories not in direct results
      let graphMemories: (Memory & { matchType: string; score?: number })[] = [];
      try {
        const seen = new Set(memories.map((m) => m.id));
        const seedNodes = await searchNodesWithScores(db, args.query, 5, queryEmbedding);

        if (seedNodes.length > 0) {
          const seeds = seedNodes.map((s) => ({ nodeId: s.node.id, score: s.score }));
          const activated = await spreadActivation(db, seeds, { maxDepth: 2 });

          // Build node→score map from seeds + activated nodes
          const nodeScoreMap = new Map<string, number>();
          for (const s of seedNodes) nodeScoreMap.set(s.node.id, s.score);
          for (const a of activated) nodeScoreMap.set(a.node.id, a.score);

          // Get memories with scores derived from their linked nodes
          const scoredMems = await getRelatedMemoriesWithScores(db, nodeScoreMap);
          const newScoredMems = scoredMems.filter((s) => !seen.has(s.memoryId));

          if (newScoredMems.length > 0) {
            const memIds = newScoredMems.slice(0, 5).map((s) => s.memoryId);
            const scoreMap = new Map(newScoredMems.map((s) => [s.memoryId, s.score]));

            const relatedMems = await db
              .selectFrom("memories")
              .selectAll()
              .where("id", "in", memIds)
              .where("archived_at", "is", null)
              .execute();

            graphMemories = relatedMems
              .map((m) => ({ ...m, matchType: "graph", score: scoreMap.get(m.id) }))
              .toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
          }
        }
      } catch (err) {
        toolLog.warning`Graph expansion failed: ${err}`;
      }

      const allResults = [...memories, ...graphMemories];

      if (allResults.length === 0) {
        return {
          output: `No memories found matching "${args.query}".`,
          details: { memories: [] },
        };
      }

      const lines = allResults.map((m) => {
        const timeStr = m.created_at ? `[${m.created_at.slice(0, 16).replace("T", " ")}] ` : "";
        const match = m.matchType ? ` [${m.matchType}]` : "";
        const score =
          "score" in m && m.score !== undefined ? ` (${(m.score * 100).toFixed(0)}%)` : "";
        return `${timeStr}[${m.id}] (${m.category}) ${m.content}${m.tags ? ` — tags: ${m.tags}` : ""}${match}${score}`;
      });

      return {
        output: `Found ${allResults.length} memories:\n${lines.join("\n")}`,
        details: { memories: allResults },
      };
    },
  };
}
