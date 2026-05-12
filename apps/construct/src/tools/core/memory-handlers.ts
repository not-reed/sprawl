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

export interface MemoryContext {
  db: Kysely<Database>;
  apiKey?: string;
  memoryManager?: MemoryManager;
  embeddingModel?: string;
  pipelineQueue?: PipelineQueue;
}

export interface MemoryArgs {
  action: string;
  content?: string;
  category?: string;
  tags?: string[];
  query?: string;
  id?: string;
  limit?: number;
  since?: string;
  before?: string;
  target?: string;
  depth?: number;
  days?: number;
  source?: string;
}

export interface HandlerResult {
  output: string;
  details?: unknown;
}

export async function handleStore(ctx: MemoryContext, args: MemoryArgs): Promise<HandlerResult> {
  if (!args.content) {
    return {
      output: 'The "store" action requires a "content" parameter.',
      details: { error: "missing_params" },
    };
  }

  const memory = await storeMemory(ctx.db, {
    content: args.content,
    category: args.category ?? "general",
    tags: args.tags ? JSON.stringify(args.tags) : null,
    source: "user",
  });

  if (ctx.apiKey) {
    generateEmbedding(ctx.apiKey, args.content, ctx.embeddingModel)
      .then((embedding) => updateMemoryEmbedding(ctx.db, memory.id, embedding))
      .then(() => toolLog.info`Embedding generated for memory [${memory.id}]`)
      .catch((err) => toolLog.error`Failed to generate embedding for [${memory.id}]: ${err}`);
  }

  if (ctx.memoryManager) {
    ctx.memoryManager
      .processStoredMemory(memory.id, args.content)
      .catch((err) => toolLog.error`Graph extraction failed for [${memory.id}]: ${err}`);
  }

  return {
    output: `Stored memory [${memory.id}]: "${memory.content}" (${memory.category})`,
    details: { memory },
  };
}

async function expandRecallViaGraph(
  ctx: MemoryContext,
  query: string,
  queryEmbedding: number[] | undefined,
  alreadySeen: Set<string>,
): Promise<(Memory & { matchType: string; score?: number })[]> {
  const seedNodes = await searchNodesWithScores(ctx.db, query, 5, queryEmbedding);
  if (seedNodes.length === 0) return [];

  const seeds = seedNodes.map((s) => ({ nodeId: s.node.id, score: s.score }));
  const activated = await spreadActivation(ctx.db, seeds, { maxDepth: 2 });

  const nodeScoreMap = new Map<string, number>();
  for (const s of seedNodes) nodeScoreMap.set(s.node.id, s.score);
  for (const a of activated) nodeScoreMap.set(a.node.id, a.score);

  const scoredMems = await getRelatedMemoriesWithScores(ctx.db, nodeScoreMap);
  const newScoredMems = scoredMems.filter((s) => !alreadySeen.has(s.memoryId));
  if (newScoredMems.length === 0) return [];

  const memIds = newScoredMems.slice(0, 5).map((s) => s.memoryId);
  const scoreMap = new Map(newScoredMems.map((s) => [s.memoryId, s.score]));

  const relatedMems = await ctx.db
    .selectFrom("memories")
    .selectAll()
    .where("id", "in", memIds)
    .where("archived_at", "is", null)
    .execute();

  return relatedMems
    .map((m) => ({ ...m, matchType: "graph", score: scoreMap.get(m.id) }))
    .toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export async function handleRecall(ctx: MemoryContext, args: MemoryArgs): Promise<HandlerResult> {
  if (!args.query) {
    return {
      output: 'The "recall" action requires a "query" parameter.',
      details: { error: "missing_params" },
    };
  }

  let queryEmbedding: number[] | undefined;
  if (ctx.apiKey) {
    try {
      queryEmbedding = await generateEmbedding(ctx.apiKey, args.query, ctx.embeddingModel);
    } catch (err) {
      toolLog.warning`Failed to generate query embedding, falling back to text search: ${err}`;
    }
  }

  const memories = await recallMemories(ctx.db, args.query, {
    category: args.category,
    limit: args.limit,
    queryEmbedding,
    since: args.since,
    before: args.before,
  });

  let graphMemories: (Memory & { matchType: string; score?: number })[] = [];
  try {
    const seen = new Set(memories.map((m) => m.id));
    graphMemories = await expandRecallViaGraph(ctx, args.query, queryEmbedding, seen);
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
    const score = "score" in m && m.score !== undefined ? ` (${(m.score * 100).toFixed(0)}%)` : "";
    return `${timeStr}[${m.id}] (${m.category}) ${m.content}${m.tags ? ` — tags: ${m.tags}` : ""}${match}${score}`;
  });

  return {
    output: `Found ${allResults.length} memories:\n${lines.join("\n")}`,
    details: { memories: allResults },
  };
}

export async function handleForget(ctx: MemoryContext, args: MemoryArgs): Promise<HandlerResult> {
  if (args.id) {
    const success = await forgetMemory(ctx.db, args.id);
    if (success) {
      return { output: `Archived memory [${args.id}].`, details: { archived: args.id } };
    }
    return {
      output: `Memory [${args.id}] not found or already archived.`,
      details: { archived: null },
    };
  }

  if (args.query) {
    const candidates = await searchMemoriesForForget(ctx.db, args.query);
    if (candidates.length === 0) {
      return {
        output: `No memories found matching "${args.query}".`,
        details: { candidates: [] },
      };
    }
    const lines = candidates.map((m) => `[${m.id}] (${m.category}) ${m.content}`);
    return {
      output: `Found ${candidates.length} memories matching "${args.query}". Call memory with action "forget" and a specific id to archive one:\n${lines.join("\n")}`,
      details: { candidates },
    };
  }

  return {
    output: 'Please provide either an "id" or a "query" to find memories to archive.',
    details: {},
  };
}

async function graphConnect(
  ctx: MemoryContext,
  query: string,
  target: string,
  maxDepth: number,
): Promise<HandlerResult> {
  const sourceNode = await findNodeByName(ctx.db, query);
  const targetNode = await findNodeByName(ctx.db, target);

  if (!sourceNode) return { output: `No node found for "${query}".` };
  if (!targetNode) return { output: `No node found for "${target}".` };

  const traversed = await traverseGraph(ctx.db, sourceNode.id, maxDepth);
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

async function graphExplore(
  ctx: MemoryContext,
  node: Awaited<ReturnType<typeof findNodeByName>> & object,
  maxDepth: number,
): Promise<HandlerResult> {
  const edges = await getNodeEdges(ctx.db, node.id);
  const traversed = await traverseGraph(ctx.db, node.id, maxDepth);

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
  if (directLines.length > 0) output += `\n\nDirect connections:\n${directLines.join("\n")}`;
  if (hopLines.length > 0)
    output += `\n\nReachable within ${maxDepth} hops:\n${hopLines.join("\n")}`;
  if (directLines.length === 0 && hopLines.length === 0) output += "\n\nNo connections found.";

  return { output, details: { node, edges, traversed } };
}

async function graphSearch(ctx: MemoryContext, query: string): Promise<HandlerResult> {
  const nodes = await searchNodes(ctx.db, query, 10);
  if (nodes.length === 0) {
    return { output: `No graph nodes matching "${query}".` };
  }
  const lines = nodes.map(
    (n) => `- ${n.display_name} (${n.node_type})${n.description ? `: ${n.description}` : ""}`,
  );
  return { output: `Found ${nodes.length} nodes:\n${lines.join("\n")}`, details: { nodes } };
}

export async function handleGraph(ctx: MemoryContext, args: MemoryArgs): Promise<HandlerResult> {
  if (!args.query) {
    return { output: 'The "graph" action requires a "query" parameter.' };
  }

  const maxDepth = Math.min(args.depth ?? 2, 3);

  if (args.target) {
    return graphConnect(ctx, args.query, args.target, maxDepth);
  }

  const node = await findNodeByName(ctx.db, args.query);
  if (node) {
    return graphExplore(ctx, node, maxDepth);
  }

  return graphSearch(ctx, args.query);
}

export async function handleStats(ctx: MemoryContext, args: MemoryArgs): Promise<HandlerResult> {
  const stats = await getUsageStats(ctx.db, { days: args.days, source: args.source });

  const period = args.days ?? 30;
  const sourceLabel = args.source ? ` (${args.source} only)` : "";

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

  return { output: lines.join("\n"), details: stats };
}

async function appendQueueSection(ctx: MemoryContext, lines: string[]): Promise<void> {
  if (!ctx.pipelineQueue) {
    lines.push("### Pipeline Queue", "  (not configured)", "");
    return;
  }
  try {
    const status = await ctx.pipelineQueue.getStatus();
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
}

async function appendMemoryStatsSection(ctx: MemoryContext, lines: string[]): Promise<void> {
  try {
    const [[obsRow], [memRow], [nodeRow], [edgeRow]] = await Promise.all([
      ctx.db.selectFrom("observations").select(ctx.db.fn.countAll<number>().as("count")).execute(),
      ctx.db
        .selectFrom("memories")
        .select(ctx.db.fn.countAll<number>().as("count"))
        .where("archived_at", "is", null)
        .execute(),
      ctx.db.selectFrom("graph_nodes").select(ctx.db.fn.countAll<number>().as("count")).execute(),
      ctx.db.selectFrom("graph_edges").select(ctx.db.fn.countAll<number>().as("count")).execute(),
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
}

async function appendDeadLetterSection(ctx: MemoryContext, lines: string[]): Promise<void> {
  try {
    const failures = await ctx.db
      .selectFrom("pipeline_jobs")
      .select(["id", "type", "last_error", "created_at", "attempts"])
      .where("status", "=", "dead_letter")
      .orderBy("created_at", "desc")
      .limit(5)
      .execute();

    if (failures.length === 0) return;

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
  } catch (err) {
    toolLog.error`Failed to get recent failures: ${err}`;
  }
}

export async function handleHealth(ctx: MemoryContext): Promise<HandlerResult> {
  const lines: string[] = ["## Memory System Health", ""];
  await appendQueueSection(ctx, lines);
  await appendMemoryStatsSection(ctx, lines);
  await appendDeadLetterSection(ctx, lines);
  return {
    output: lines.join("\n"),
    details: { pipelineQueueConfigured: !!ctx.pipelineQueue },
  };
}
