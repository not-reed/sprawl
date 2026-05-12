import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { MemoryManager, PipelineQueue } from "@repo/cairn";
import type { Database } from "../../db/schema.js";
import {
  type HandlerResult,
  type MemoryArgs,
  type MemoryContext,
  handleStore,
  handleRecall,
  handleForget,
  handleGraph,
  handleStats,
  handleHealth,
} from "./memory-handlers.js";

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

const handlers: Record<
  MemoryInput["action"],
  (ctx: MemoryContext, args: MemoryArgs) => Promise<HandlerResult>
> = {
  store: handleStore,
  recall: handleRecall,
  forget: handleForget,
  graph: handleGraph,
  stats: handleStats,
  health: (ctx) => handleHealth(ctx),
};

export function createMemoryTool(
  db: Kysely<Database>,
  apiKey?: string,
  memoryManager?: MemoryManager,
  embeddingModel?: string,
  pipelineQueue?: PipelineQueue,
) {
  const ctx: MemoryContext = { db, apiKey, memoryManager, embeddingModel, pipelineQueue };

  return {
    name: "memory" as const,
    description:
      'Long-term memory and usage stats. Actions: "store" saves a fact/note/preference, "recall" searches memories, "forget" archives a memory, "graph" explores concept connections, "stats" shows AI usage statistics, "health" shows pipeline queue status and memory system health.',
    parameters: MemoryParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as MemoryInput;
      const handler = handlers[typed.action];
      if (!handler) {
        return {
          output: `Unknown action: ${typed.action}`,
          details: { error: "unknown_action" },
        };
      }
      return handler(ctx, typed);
    },
  };
}
