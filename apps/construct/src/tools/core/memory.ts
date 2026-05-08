import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import {
  storeMemory,
  updateMemoryEmbedding,
  generateEmbedding,
  recallMemories,
  searchNodes,
  findNodeByName,
  traverseGraph,
  getNodeEdges,
  forgetMemory,
  searchMemoriesForForget,
  spreadActivation,
  searchNodesWithScores,
  getRelatedMemoriesWithScores,
  type Memory,
  type MemoryManager,
  type PipelineQueue,
} from "@repo/cairn";
import type { Database } from "../../db/schema.js";
import { getUsageStats } from "../../db/queries.js";
import { toolLog } from "../../logger.js";

const MemoryParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("store"),
      Type.Literal("recall"),
      Type.Literal("forget"),
      Type.Literal("graph"),
      Type.Literal("stats"),
      Type.Literal("health"),
    ],
    {
      description:
        'Action: "store" a memory, "recall" memories, "forget" (archive) a memory, "graph" explore concept connections, "stats" show usage statistics, "health" show pipeline queue and memory health',
    },
  ),
  // store params
  content: Type.Optional(
    Type.String({ description: 'Content to store (required for "store" action)' }),
  ),
  category: Type.Optional(
    Type.String({
      description:
        'Category for "store": general, preference, fact, reminder, note. Defaults to general.',
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: "Tags for keyword search (store action)" }),
  ),
  // recall/forget params
  query: Type.Optional(
    Type.String({ description: 'Search query for "recall" or "forget" actions' }),
  ),
  id: Type.Optional(Type.String({ description: 'Specific memory ID for "forget" action' })),
  limit: Type.Optional(
    Type.Number({ description: 'Max results for "recall" action (default: 10)' }),
  ),
  since: Type.Optional(
    Type.String({
      description: 'ISO date filter for "recall": only memories created on or after this date',
    }),
  ),
  before: Type.Optional(
    Type.String({
      description: 'ISO date filter for "recall": only memories created before this date',
    }),
  ),
  // graph params
  target: Type.Optional(Type.String({ description: 'Second concept for "graph" connect action' })),
  depth: Type.Optional(
    Type.Number({ description: 'Max traversal hops for "graph" action (default: 2, max: 3)' }),
  ),
  // stats params
  days: Type.Optional(
    Type.Number({
      description: 'Number of days for "stats" (default 30, max 365)',
      minimum: 1,
      maximum: 365,
    }),
  ),
  source: Type.Optional(
    Type.String({ description: 'Filter "stats" by source: "telegram" or "cli"' }),
  ),
});

type MemoryInput = Static<typeof MemoryParams>;

export function createMemoryTool(
  db: Kysely<Database>,
  apiKey?: string,
  memoryManager?: MemoryManager,
  embeddingModel?: string,
  pipelineQueue?: PipelineQueue,
) {
  return {
    name: "memory" as const,
    description:
      'Long-term memory and usage stats. Actions: "store" saves a fact/note/preference, "recall" searches memories, "forget" archives a memory, "graph" explores concept connections, "stats" shows AI usage statistics, "health" shows pipeline queue status and memory system health.',
    parameters: MemoryParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as MemoryInput;

      switch (typed.action) {
        // --- store ---
        case "store": {
          if (!typed.content) {
            return {
              output: 'The "store" action requires a "content" parameter.',
              details: { error: "missing_params" },
            };
          }

          const memory = await storeMemory(db, {
            content: typed.content,
            category: typed.category ?? "general",
            tags: typed.tags ? JSON.stringify(typed.tags) : null,
            source: "user",
          });

          if (apiKey) {
            generateEmbedding(apiKey, typed.content, embeddingModel)
              .then((embedding) => updateMemoryEmbedding(db, memory.id, embedding))
              .then(() => toolLog.info`Embedding generated for memory [${memory.id}]`)
              .catch(
                (err) => toolLog.error`Failed to generate embedding for [${memory.id}]: ${err}`,
              );
          }

          if (memoryManager) {
            memoryManager
              .processStoredMemory(memory.id, typed.content)
              .catch((err) => toolLog.error`Graph extraction failed for [${memory.id}]: ${err}`);
          }

          return {
            output: `Stored memory [${memory.id}]: "${memory.content}" (${memory.category})`,
            details: { memory },
          };
        }

        // --- recall ---
        case "recall": {
          if (!typed.query) {
            return {
              output: 'The "recall" action requires a "query" parameter.',
              details: { error: "missing_params" },
            };
          }

          let queryEmbedding: number[] | undefined;
          if (apiKey) {
            try {
              queryEmbedding = await generateEmbedding(apiKey, typed.query, embeddingModel);
            } catch (err) {
              toolLog.warning`Failed to generate query embedding, falling back to text search: ${err}`;
            }
          }

          const memories = await recallMemories(db, typed.query, {
            category: typed.category,
            limit: typed.limit,
            queryEmbedding,
            since: typed.since,
            before: typed.before,
          });

          let graphMemories: (Memory & { matchType: string; score?: number })[] = [];
          try {
            const seen = new Set(memories.map((m) => m.id));
            const seedNodes = await searchNodesWithScores(db, typed.query, 5, queryEmbedding);

            if (seedNodes.length > 0) {
              const seeds = seedNodes.map((s) => ({ nodeId: s.node.id, score: s.score }));
              const activated = await spreadActivation(db, seeds, { maxDepth: 2 });

              const nodeScoreMap = new Map<string, number>();
              for (const s of seedNodes) nodeScoreMap.set(s.node.id, s.score);
              for (const a of activated) nodeScoreMap.set(a.node.id, a.score);

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
              output: `No memories found matching "${typed.query}".`,
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
        }

        // --- forget ---
        case "forget": {
          if (typed.id) {
            const success = await forgetMemory(db, typed.id);
            if (success) {
              return {
                output: `Archived memory [${typed.id}].`,
                details: { archived: typed.id },
              };
            }
            return {
              output: `Memory [${typed.id}] not found or already archived.`,
              details: { archived: null },
            };
          }

          if (typed.query) {
            const candidates = await searchMemoriesForForget(db, typed.query);
            if (candidates.length === 0) {
              return {
                output: `No memories found matching "${typed.query}".`,
                details: { candidates: [] },
              };
            }

            const lines = candidates.map((m) => `[${m.id}] (${m.category}) ${m.content}`);
            return {
              output: `Found ${candidates.length} memories matching "${typed.query}". Call memory with action "forget" and a specific id to archive one:\n${lines.join("\n")}`,
              details: { candidates },
            };
          }

          return {
            output: 'Please provide either an "id" or a "query" to find memories to archive.',
            details: {},
          };
        }

        // --- graph ---
        case "graph": {
          if (!typed.query) {
            return { output: 'The "graph" action requires a "query" parameter.' };
          }

          const maxDepth = Math.min(typed.depth ?? 2, 3);

          if (typed.target) {
            // connect action equivalent
            const sourceNode = await findNodeByName(db, typed.query);
            const targetNode = await findNodeByName(db, typed.target);

            if (!sourceNode) return { output: `No node found for "${typed.query}".` };
            if (!targetNode) return { output: `No node found for "${typed.target}".` };

            const traversed = await traverseGraph(db, sourceNode.id, maxDepth);
            const targetHit = traversed.find((t) => t.node.id === targetNode.id);

            if (targetHit) {
              return {
                output: `"${sourceNode.display_name}" connects to "${targetNode.display_name}" at depth ${targetHit.depth} via "${targetHit.via_relation}".`,
                details: { source: sourceNode, target: targetNode, path: targetHit },
              };
            }

            return {
              output: `No connection found between "${sourceNode.display_name}" and "${targetNode.display_name}" within ${maxDepth} hops.`,
              details: { source: sourceNode, target: targetNode },
            };
          }

          // search or explore
          // If no target, try "search" first to see if query matches a node name
          const node = await findNodeByName(db, typed.query);
          if (node) {
            // explore mode
            const edges = await getNodeEdges(db, node.id);
            const traversed = await traverseGraph(db, node.id, maxDepth);

            const directLines = edges.map((e) => {
              const isSource = e.source_id === node.id;
              const direction = isSource ? "→" : "←";
              return `  ${direction} ${e.relation} (weight: ${e.weight})`;
            });

            const hopLines = traversed.map(
              (t) =>
                `  ${"  ".repeat(t.depth - 1)}↳ ${t.node.display_name} (${t.node.node_type}, depth ${t.depth}${t.via_relation ? `, via "${t.via_relation}"` : ""})`,
            );

            let output = `Node: ${node.display_name} (${node.node_type})`;
            if (node.description) output += `\n${node.description}`;
            if (directLines.length > 0)
              output += `\n\nDirect connections:\n${directLines.join("\n")}`;
            if (hopLines.length > 0)
              output += `\n\nReachable within ${maxDepth} hops:\n${hopLines.join("\n")}`;
            if (directLines.length === 0 && hopLines.length === 0)
              output += "\n\nNo connections found.";

            return {
              output,
              details: { node, edges, traversed },
            };
          }

          // Fallback: search nodes
          const nodes = await searchNodes(db, typed.query, 10);
          if (nodes.length === 0) {
            return { output: `No graph nodes matching "${typed.query}".` };
          }

          const lines = nodes.map(
            (n) =>
              `- ${n.display_name} (${n.node_type})${n.description ? `: ${n.description}` : ""}`,
          );
          return {
            output: `Found ${nodes.length} nodes:\n${lines.join("\n")}`,
            details: { nodes },
          };
        }

        // --- stats ---
        case "stats": {
          const stats = await getUsageStats(db, {
            days: typed.days,
            source: typed.source,
          });

          const period = typed.days ?? 30;
          const sourceLabel = typed.source ? ` (${typed.source} only)` : "";

          const lines: string[] = [
            `Usage stats — last ${period} day(s)${sourceLabel}:`,
            `  Total cost: $${stats.total_cost.toFixed(4)}`,
            `  Input tokens: ${stats.total_input_tokens.toLocaleString()}`,
            `  Output tokens: ${stats.total_output_tokens.toLocaleString()}`,
            `  Messages: ${stats.message_count}`,
          ];

          if (stats.daily.length > 0) {
            lines.push("", "Per-day breakdown:");
            for (const d of stats.daily) {
              lines.push(`  ${d.date}  $${d.cost.toFixed(4)}  ${d.messages} msgs`);
            }
          }

          return {
            output: lines.join("\n"),
            details: stats,
          };
        }

        // --- health ---
        case "health": {
          const lines: string[] = ["## Memory System Health", ""];

          // Queue status
          if (pipelineQueue) {
            try {
              const status = await pipelineQueue.getStatus();
              lines.push(
                "### Pipeline Queue",
                `  Pending:     ${status.pending}`,
                `  Running:     ${status.running}`,
                `  Completed:   ${status.completed}`,
                `  Failed:      ${status.failed}`,
                `  Dead letter: ${status.dead_letter}`,
                "",
              );
            } catch (err) {
              toolLog.error`Failed to get queue status: ${err}`;
            }
          } else {
            lines.push("### Pipeline Queue", "  (not configured)", "");
          }

          // Memory statistics
          try {
            const [[obsRow], [memRow], [nodeRow], [edgeRow]] = await Promise.all([
              db.selectFrom("observations").select(db.fn.countAll<number>().as("count")).execute(),
              db
                .selectFrom("memories")
                .select(db.fn.countAll<number>().as("count"))
                .where("archived_at", "is", null)
                .execute(),
              db.selectFrom("graph_nodes").select(db.fn.countAll<number>().as("count")).execute(),
              db.selectFrom("graph_edges").select(db.fn.countAll<number>().as("count")).execute(),
            ]);

            lines.push(
              "### Memory Statistics",
              `  Observations:   ${obsRow?.count ?? 0}`,
              `  Memories:       ${memRow?.count ?? 0}`,
              `  Graph nodes:    ${nodeRow?.count ?? 0}`,
              `  Graph edges:    ${edgeRow?.count ?? 0}`,
              "",
            );
          } catch (err) {
            toolLog.error`Failed to get memory stats: ${err}`;
          }

          // Recent dead letter failures
          try {
            const failures = await db
              .selectFrom("pipeline_jobs")
              .select(["id", "type", "last_error", "created_at", "attempts"])
              .where("status", "=", "dead_letter")
              .orderBy("created_at", "desc")
              .limit(5)
              .execute();

            if (failures.length > 0) {
              lines.push("### Recent Failures (dead letter)");
              for (const f of failures) {
                const time = f.created_at ? f.created_at.slice(0, 16).replace("T", " ") : "?";
                const errBrief = f.last_error?.slice(0, 120) ?? "(no error detail)";
                lines.push(
                  `  [${f.id.slice(0, 8)}] ${f.type} | ${time} | attempts: ${f.attempts}`,
                  `    ${errBrief}`,
                );
              }
              lines.push("");
            }
          } catch (err) {
            toolLog.error`Failed to get recent failures: ${err}`;
          }

          return {
            output: lines.join("\n"),
            details: { pipelineQueueConfigured: !!pipelineQueue },
          };
        }

        default:
          return {
            output: `Unknown action: ${typed.action}`,
            details: { error: "unknown_action" },
          };
      }
    },
  };
}
