import { Agent, type AgentTool, type AgentToolResult } from "@mariozechner/pi-agent-core";
import { getModel, type Usage } from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Kysely } from "kysely";

import { env } from "./env.js";
import { getSystemPrompt, buildContextPreamble } from "./system-prompt.js";
import { startActiveSpan, withSpan } from "./tracing.js";
import { agentLog, toolLog } from "./logger.js";
import type { Database } from "./db/schema.js";
import type { TelegramContext } from "./telegram/types.js";
import {
  getOrCreateConversation,
  getRecentMessages,
  getRecentMemories,
  recallMemories,
  saveMessage,
  trackUsage,
  getSetting,
  setSetting,
} from "./db/queries.js";
import {
  generateEmbedding,
  cosineSimilarity,
  estimateTokens,
  SIMILARITY,
  type WorkerModelConfig,
  PipelineQueue as PipelineQueueClass,
} from "@repo/cairn";
import {
  ConstructMemoryManager,
  CONSTRUCT_OBSERVER_PROMPT,
  CONSTRUCT_REFLECTOR_PROMPT,
} from "./memory.js";
import { extractSkillsFromObservations, detectConflicts } from "./skills/discovery.js";
import { createAllTools, type InternalTool } from "./tools/packs.js";
import {
  getExtensionRegistry,
  selectAndCreateDynamicTools,
  selectAndRetrieveSkillInstructions,
} from "./extensions/index.js";
import { upsertNode, upsertEdge } from "@repo/cairn";
import { estimateCost } from "./model-pricing.js";

const workerConfig = (): WorkerModelConfig | null =>
  env.MEMORY_WORKER_MODEL
    ? {
        apiKey: env.OPENROUTER_API_KEY,
        model: env.MEMORY_WORKER_MODEL,
        baseUrl: env.OPENROUTER_BASE_URL,
        extraBody: { reasoning: { max_tokens: 1 } },
      }
    : null;

// Adapt internal tool → pi-agent-core AgentTool
function createPiTool<T extends TSchema>(tool: InternalTool<T>): AgentTool<T, unknown> {
  return {
    name: tool.name,
    label: tool.name.replace(/_/g, " "),
    description: tool.description,
    parameters: tool.parameters,
    execute: async (toolCallId: string, params: Static<T>): Promise<AgentToolResult<unknown>> => {
      toolLog.info`Executing tool: ${tool.name}`;
      toolLog.debug`Tool params: ${JSON.stringify(params)}`;
      try {
        const result = await tool.execute(toolCallId, params);
        toolLog.info`Tool ${tool.name} completed`;
        return {
          content: [{ type: "text", text: result.output }],
          details: result.details,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolLog.error`Tool ${tool.name} failed: ${msg}`;
        return {
          content: [{ type: "text", text: `Tool error: ${msg}` }],
          details: { error: msg },
        };
      }
    },
  };
}

export interface AgentResponse {
  text: string;
  toolCalls: Array<{ name: string; args: unknown; result: string }>;
  usage?: { input: number; output: number; cost: number };
  messageId?: string;
}

export interface ProcessMessageOpts {
  source: "telegram" | "cli" | "scheduler";
  externalId: string | null;
  chatId?: string;
  telegram?: TelegramContext;
  replyContext?: string;
  incomingTelegramMessageId?: number;
  scheduleId?: string;
  pipelineQueue?: PipelineQueueClass;
}

export const isDev = env.NODE_ENV === "development";

// ============================================================================
// Phase 3 decomposition types
// ============================================================================

interface AssembledContext {
  conversationId: string;
  memoryManager: ConstructMemoryManager;
  historyMessages: Array<{
    role: string;
    content: string;
    created_at?: string;
    telegram_message_id?: number | null;
  }>;
  preamble: string;
  queryEmbedding: number[] | undefined;
  selectedInstructions: string[];
  selectedInstructionIds: string[];
  recentMemories: Array<{ content: string; category: string; created_at: string }>;
  relevantMemories: Array<{
    content: string;
    category: string;
    score?: number;
    matchType?: string;
  }>;
  hasObservations: boolean;
  observationsText: string;
}

interface TurnResult {
  responseText: string;
  toolCalls: AgentResponse["toolCalls"];
  totalUsage: { input: number; output: number; cost: number };
  hasUsage: boolean;
  toolErrors: Array<{ toolName: string; result: string }>;
  toolSuccesses: number;
}

// ============================================================================
// Core pipeline
// ============================================================================

export async function processMessage(
  db: Kysely<Database>,
  message: string,
  opts: ProcessMessageOpts,
): Promise<AgentResponse> {
  agentLog.info`Processing message from ${opts.source}${opts.chatId ? ` (chat ${opts.chatId})` : ""}`;

  const tags = [opts.source, ...(opts.scheduleId ? ["scheduler"] : [])];
  const rootSpan = startActiveSpan({
    name: "process_message",
    spanType: "EXECUTOR",
    input: { message, source: opts.source, chatId: opts.chatId ?? opts.externalId },
    tags,
  });

  try {
    const ctx = await assembleContext(db, message, opts, rootSpan);
    const result = await executeTurn(db, message, opts, ctx);
    const assistantMessageId = await persistTurn(db, opts, ctx, result);

    runPostTurn(db, opts, ctx, result, assistantMessageId).catch(
      (err: unknown) => agentLog.error`Post-turn pipeline failed: ${err}`,
    );

    const usage = result.hasUsage ? result.totalUsage : undefined;

    rootSpan.setAttributes({
      output: result.responseText,
      tool_call_count: result.toolCalls.length,
      ...(result.hasUsage
        ? {
            input_tokens: result.totalUsage.input,
            output_tokens: result.totalUsage.output,
            cost_usd: result.totalUsage.cost,
          }
        : {}),
    });

    return {
      text: result.responseText,
      toolCalls: result.toolCalls,
      usage,
      messageId: assistantMessageId,
    };
  } finally {
    rootSpan.end();
  }
}

// ============================================================================
// Phase 3: Decomposed subroutines
// ============================================================================

async function assembleContext(
  db: Kysely<Database>,
  message: string,
  opts: ProcessMessageOpts,
  rootSpan: ReturnType<typeof startActiveSpan>,
): Promise<AssembledContext> {
  const conversationId = await getOrCreateConversation(db, opts.source, opts.externalId);
  rootSpan.setAttribute("conversation_id", conversationId);
  if (opts.scheduleId) rootSpan.setAttribute("schedule_id", opts.scheduleId);

  const contextSpan = startActiveSpan({ name: "context_assembly" });

  const memoryManager = new ConstructMemoryManager(db, {
    workerConfig: workerConfig(),
    embeddingModel: env.EMBEDDING_MODEL,
    apiKey: env.OPENROUTER_API_KEY,
    observerPrompt: CONSTRUCT_OBSERVER_PROMPT,
    reflectorPrompt: CONSTRUCT_REFLECTOR_PROMPT,
    logger: agentLog,
  });

  const { observationsText, activeMessages, hasObservations, evictedObservations } =
    await memoryManager.buildContext(conversationId);

  let historyMessages: typeof activeMessages;
  if (hasObservations) {
    historyMessages = activeMessages;
    agentLog.debug`Context: ${observationsText.split("\n").length} observations, ${activeMessages.length} active messages${evictedObservations > 0 ? `, ${evictedObservations} evicted` : ""}`;
  } else {
    historyMessages = await getRecentMessages(db, conversationId, 20);
    agentLog.debug`Loaded ${historyMessages.length} history messages (no observations)`;
  }

  const recentMemoriesRaw = await getRecentMemories(db, 10);

  let queryEmbedding: number[] | undefined;
  let recentMemories: typeof recentMemoriesRaw = [];
  let relevantMemories: Array<{
    content: string;
    category: string;
    score?: number;
    matchType?: string;
  }> = [];
  try {
    queryEmbedding = await generateEmbedding(env.OPENROUTER_API_KEY, message, env.EMBEDDING_MODEL);

    recentMemories = recentMemoriesRaw.filter((m) => {
      if (!m.embedding) return false;
      try {
        const sim = cosineSimilarity(queryEmbedding!, JSON.parse(m.embedding.toString()));
        return sim >= SIMILARITY.RECENT_MEMORY_MIN;
      } catch {
        return false;
      }
    });

    const results = await recallMemories(db, message, {
      limit: 5,
      queryEmbedding,
      similarityThreshold: SIMILARITY.RECALL_STRICT,
    });
    const recentIds = new Set(recentMemories.map((m) => m.id));
    relevantMemories = results
      .filter((m) => !recentIds.has(m.id))
      .map((m) => ({
        content: m.content,
        category: m.category,
        score: m.score,
        matchType: m.matchType,
      }));
  } catch {
    recentMemories = recentMemoriesRaw;
  }

  agentLog.debug`Context: ${recentMemories.length} recent memories, ${relevantMemories.length} relevant memories`;

  const { formatted: selectedInstructions, instructionIds: selectedInstructionIds } =
    await selectAndRetrieveSkillInstructions(queryEmbedding);

  if (selectedInstructions.length > 1) {
    try {
      const conflicts = await detectConflicts(db, env.OPENROUTER_API_KEY, env.EMBEDDING_MODEL);
      if (conflicts.length > 0) {
        agentLog.warning`Conflicting instructions detected in this context: ${conflicts.length} conflict(s)`;
        for (const conflict of conflicts) {
          agentLog.warning`- ${conflict.conflictType}: "${conflict.instructionA.text}" vs "${conflict.instructionB.text}"`;
        }
      }
    } catch (err) {
      agentLog.debug`Failed to check for instruction conflicts: ${err}`;
    }
  }

  contextSpan.setAttributes({
    has_observations: hasObservations,
    active_messages: activeMessages.length,
    recent_memories: recentMemories.length,
    relevant_memories: relevantMemories.length,
    skill_instructions: selectedInstructions.length,
  });
  contextSpan.end();

  const preamble = buildContextPreamble({
    timezone: env.TIMEZONE,
    source: opts.source,
    dev: isDev,
    observations: observationsText || undefined,
    recentMemories: recentMemories.map((m) => ({
      content: m.content,
      category: m.category,
      created_at: m.created_at,
    })),
    relevantMemories,
    skillInstructions: selectedInstructions,
    replyContext: opts.replyContext,
  });

  return {
    conversationId,
    memoryManager,
    historyMessages,
    preamble,
    queryEmbedding,
    selectedInstructions,
    selectedInstructionIds,
    recentMemories: recentMemories.map((m) => ({
      content: m.content,
      category: m.category,
      created_at: m.created_at,
    })),
    relevantMemories,
    hasObservations,
    observationsText: observationsText || "",
  };
}

async function executeTurn(
  db: Kysely<Database>,
  message: string,
  opts: ProcessMessageOpts,
  ctx: AssembledContext,
): Promise<TurnResult> {
  const { identity } = getExtensionRegistry();
  const model = getModel("openrouter", env.OPENROUTER_MODEL as Parameters<typeof getModel>[1]);
  const agent = new Agent({
    initialState: {
      systemPrompt: getSystemPrompt(identity),
      model,
    },
  });

  const chatId = opts.chatId ?? opts.externalId ?? "unknown";
  const toolCtx = {
    db,
    chatId,
    apiKey: env.OPENROUTER_API_KEY,
    projectRoot: env.PROJECT_ROOT,
    dbPath: env.DATABASE_URL,
    timezone: env.TIMEZONE,
    tavilyApiKey: env.TAVILY_API_KEY,
    logFile: env.LOG_FILE,
    isDev,
    extensionsDir: env.EXTENSIONS_DIR,
    telegram: opts.telegram,
    memoryManager: ctx.memoryManager,
    embeddingModel: env.EMBEDDING_MODEL,
    pipelineQueue: opts.pipelineQueue,
  };
  const builtinTools = createAllTools(toolCtx);
  const dynamicTools = selectAndCreateDynamicTools(ctx.queryEmbedding, toolCtx);
  const tools = [...builtinTools, ...dynamicTools];
  agent.state.tools = tools.map((t) => createPiTool(t));

  for (const msg of ctx.historyMessages) {
    const tgPrefix = msg.telegram_message_id ? `[tg:${msg.telegram_message_id}] ` : "";
    const timeStr = msg.created_at ? `[${msg.created_at.slice(0, 16).replace("T", " ")}] ` : "";
    if (msg.role === "user") {
      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "user",
          content: timeStr + tgPrefix + msg.content,
          timestamp: Date.now(),
        },
      ];
    } else if (msg.role === "assistant") {
      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
          api: "openrouter",
          provider: "openrouter",
          model: env.OPENROUTER_MODEL,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ];
    }
  }

  let responseText = "";
  const toolCalls: AgentResponse["toolCalls"] = [];
  const totalUsage = { input: 0, output: 0, cost: 0 };
  let hasUsage = false;

  const toolErrors: Array<{ toolName: string; result: string }> = [];
  let toolSuccesses = 0;

  agent.subscribe((event) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        responseText += event.assistantMessageEvent.delta;
      }
    }
    if (event.type === "message_end") {
      const msg = event.message;
      if ("usage" in msg) {
        const u = msg.usage as Usage;
        totalUsage.input += u.input;
        totalUsage.output += u.output;
        totalUsage.cost += u.cost.total;
        hasUsage = true;
      }
    }
    if (event.type === "tool_execution_end") {
      toolCalls.push({
        name: event.toolName,
        args: undefined,
        result: String(event.result),
      });

      if (event.isError) {
        toolErrors.push({ toolName: event.toolName, result: String(event.result) });
      } else {
        toolSuccesses++;
      }
    }
  });

  await saveMessage(db, {
    conversation_id: ctx.conversationId,
    role: "user",
    content: message,
    telegram_message_id: opts.incomingTelegramMessageId ?? null,
  });

  const systemPromptText = getSystemPrompt(identity);
  const systemTokens = estimateTokens(systemPromptText);
  const observationTokens = ctx.observationsText ? estimateTokens(ctx.observationsText) : 0;
  const recentMemTokens = ctx.recentMemories.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const relevantMemTokens = ctx.relevantMemories.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  );
  const instructionTokens = ctx.selectedInstructions.reduce(
    (sum, instr) => sum + estimateTokens(instr),
    0,
  );
  const historyTokens = ctx.historyMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const toolCount = tools.length;
  const preambleTokens = estimateTokens(ctx.preamble);
  const totalContextTokens = systemTokens + preambleTokens + historyTokens;
  agentLog.info`Context breakdown: system=${systemTokens} observations=${observationTokens} recentMem=${recentMemTokens}(${ctx.recentMemories.length}) relevantMem=${relevantMemTokens}(${ctx.relevantMemories.length}) instructions=${instructionTokens}(${ctx.selectedInstructions.length}) history=${historyTokens}(${ctx.historyMessages.length}msgs) tools=${toolCount} preamble=${preambleTokens} total=${totalContextTokens}`;

  if (ctx.selectedInstructions.length > 0) {
    agentLog.debug`Injected skill instructions:\n${ctx.selectedInstructions.join("\n")}`;
  }

  if (ctx.relevantMemories.length > 0) {
    const memSummary = ctx.relevantMemories
      .map((m) => {
        const match = m.matchType ?? "unknown";
        const score = m.score !== undefined ? ` score=${m.score.toFixed(2)}` : "";
        return `  [${match}${score}] (${m.category}) ${m.content.slice(0, 100)}${m.content.length > 100 ? "..." : ""}`;
      })
      .join("\n");
    agentLog.debug`Relevant memories:\n${memSummary}`;
  }

  agentLog.debug`Prompting agent`;
  const llmSpan = startActiveSpan({
    name: "llm_call",
    spanType: "LLM",
    input: { prompt: ctx.preamble + message, model: env.OPENROUTER_MODEL },
  });
  await agent.prompt(ctx.preamble + message);
  await agent.waitForIdle();
  llmSpan.setAttributes({
    output: responseText,
    input_tokens: totalUsage.input,
    output_tokens: totalUsage.output,
    cost_usd: totalUsage.cost,
    tool_call_count: toolCalls.length,
  });
  llmSpan.end();
  agentLog.info`Agent finished. Response length: ${responseText.length}, tool calls: ${toolCalls.length}`;

  responseText = responseText.replace(/\[tg:\d+\]\s*/g, "");
  responseText = responseText.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*/gm, "");

  return { responseText, toolCalls, totalUsage, hasUsage, toolErrors, toolSuccesses };
}

async function persistTurn(
  db: Kysely<Database>,
  opts: ProcessMessageOpts,
  ctx: AssembledContext,
  result: TurnResult,
): Promise<string> {
  const assistantMessageId = await saveMessage(db, {
    conversation_id: ctx.conversationId,
    role: "assistant",
    content: result.responseText,
    tool_calls: result.toolCalls.length > 0 ? JSON.stringify(result.toolCalls) : null,
  });

  if (result.hasUsage) {
    agentLog.info`Usage: ${result.totalUsage.input} in / ${result.totalUsage.output} out / $${result.totalUsage.cost.toFixed(4)}`;
    await trackUsage(db, {
      model: env.OPENROUTER_MODEL,
      input_tokens: result.totalUsage.input,
      output_tokens: result.totalUsage.output,
      cost_usd: result.totalUsage.cost,
      source: opts.source,
    });
  }

  return assistantMessageId;
}

async function runPostTurn(
  db: Kysely<Database>,
  opts: ProcessMessageOpts,
  ctx: AssembledContext,
  result: TurnResult,
  assistantMessageId: string,
): Promise<void> {
  const { conversationId, memoryManager, selectedInstructionIds } = ctx;

  if (selectedInstructionIds.length > 0 && result.toolCalls.length > 0) {
    try {
      const eventNodeName = `conv:${conversationId}:${assistantMessageId}`;
      const eventNode = await upsertNode(db, {
        name: eventNodeName,
        type: "conversation_event",
      });

      const instrNodeIds = new Map<string, string>();
      for (const instrId of selectedInstructionIds) {
        const node = await upsertNode(db, { name: instrId, type: "skill_instruction" });
        instrNodeIds.set(instrId, node.id);
      }

      if (result.toolErrors.length === 0 && result.toolSuccesses > 0) {
        for (const graphNodeId of instrNodeIds.values()) {
          await upsertEdge(db, {
            source_id: graphNodeId,
            target_id: eventNode.id,
            relation: "applied_in",
          });
        }
        agentLog.debug`Created applied_in edges: ${instrNodeIds.size} instructions → ${eventNodeName}`;
      }

      if (result.toolErrors.length > 0) {
        const executions = await db
          .selectFrom("skill_executions")
          .where("conversation_id", "=", conversationId)
          .where("implicated_instruction_id", "is not", null)
          .where("had_tool_errors", "=", 1)
          .select("implicated_instruction_id")
          .execute();

        const implicatedIds = new Set(
          executions
            .map((e) => e.implicated_instruction_id)
            .filter((id): id is string => id != null),
        );

        const failedIds = implicatedIds.size > 0 ? implicatedIds : new Set(selectedInstructionIds);
        const errorSummary = result.toolErrors
          .map((e) => `${e.toolName}: ${e.result.slice(0, 100)}`)
          .join("; ");

        for (const instrId of failedIds) {
          const graphNodeId = instrNodeIds.get(instrId);
          if (graphNodeId) {
            await upsertEdge(db, {
              source_id: graphNodeId,
              target_id: eventNode.id,
              relation: "failed_on",
              properties: { errors: errorSummary },
            });
          }
        }
        agentLog.debug`Created failed_on edges: ${failedIds.size} instructions → ${eventNodeName}`;
      }
    } catch (err) {
      agentLog.warning`Failed to create skill instruction graph edges: ${err}`;
    }
  }

  try {
    if (opts.pipelineQueue) {
      // Enqueue the full post-turn pipeline (observer → promoter → reflector)
      // via the queue for crash-recoverable execution.
      opts.pipelineQueue
        .enqueue("post_turn", conversationId)
        .catch((err: unknown) => agentLog.error`Pipeline enqueue failed: ${err}`);

      // Skill extraction runs as fire-and-forget independently
      runSkillExtraction(db, opts, memoryManager, conversationId).catch(
        (err: unknown) => agentLog.warning`Skill extraction failed: ${err}`,
      );
    } else {
      const ran = await memoryManager.runObserver(conversationId);
      if (ran) {
        await memoryManager.promoteObservations(conversationId);

        try {
          const activeObs = await memoryManager.getActiveObservations(conversationId);
          const extracted = await extractSkillsFromObservations(
            activeObs,
            env.OPENROUTER_API_KEY,
            env.EMBEDDING_MODEL,
          );

          if (extracted.length > 0) {
            agentLog.info`Extracted ${extracted.length} potential skill(s) from observations`;

            if (opts.source === "telegram" && opts.chatId && opts.chatId !== "unknown") {
              try {
                const candidate = extracted
                  .filter((s) => s.confidence >= 0.7)
                  .toSorted((a, b) => b.confidence - a.confidence)[0];

                if (candidate) {
                  const exists = await db
                    .selectFrom("skills")
                    .select("id")
                    .where("name", "=", candidate.name)
                    .executeTakeFirst();

                  if (!exists) {
                    const normalizedName = candidate.name.toLowerCase().replace(/[^a-z0-9]/g, "-");
                    const ignoredAt = await getSetting(db, `ignored_skill:${normalizedName}`);
                    const stillIgnored =
                      ignoredAt &&
                      Date.now() - new Date(ignoredAt).getTime() < 7 * 24 * 60 * 60 * 1000;

                    const lastNudge = await getSetting(db, `skill_nudge_cooldown:${opts.chatId}`);
                    const onCooldown =
                      lastNudge && Date.now() - new Date(lastNudge).getTime() < 24 * 60 * 60 * 1000;

                    if (!stillIgnored && !onCooldown) {
                      const payload = JSON.stringify({
                        name: candidate.name,
                        description: candidate.description,
                        body: candidate.body,
                      });
                      await setSetting(db, `skill_nudge:${opts.chatId}`, payload);
                      await setSetting(
                        db,
                        `skill_nudge_cooldown:${opts.chatId}`,
                        new Date().toISOString(),
                      );
                      agentLog.info`Queued skill nudge for chat ${opts.chatId}: "${candidate.name}"`;
                    }
                  }
                }
              } catch (err) {
                agentLog.warning`Failed to queue skill nudge: ${err}`;
              }
            }
          }
        } catch (err) {
          agentLog.warning`Failed to extract skills from observations: ${err}`;
        }
      }

      await withSpan({ name: "reflector", spanType: "DEFAULT" }, async (span) => {
        const obsBefore = await memoryManager.getActiveObservations(conversationId);
        const tokensBefore = obsBefore.reduce((sum, o) => sum + (o.token_count ?? 0), 0);
        span.setAttributes({
          observations_before: obsBefore.length,
          tokens_before: tokensBefore,
        });
        span.setInput(
          obsBefore.map((o) => `[${o.id}] (${o.priority}, ${o.observation_date}) ${o.content}`),
        );

        const { ran: reflectorRan, usage: reflectorUsage } =
          await memoryManager.runReflector(conversationId);
        span.setAttribute("ran", reflectorRan);

        if (reflectorRan) {
          const obsAfter = await memoryManager.getActiveObservations(conversationId);
          const tokensAfter = obsAfter.reduce((sum, o) => sum + (o.token_count ?? 0), 0);
          const afterIds = new Set(obsAfter.map((o) => o.id));
          const dropped = obsBefore.filter((o) => !afterIds.has(o.id));
          span.setAttributes({
            observations_after: obsAfter.length,
            tokens_after: tokensAfter,
            observations_delta: obsBefore.length - obsAfter.length,
            tokens_delta: tokensBefore - tokensAfter,
          });
          const wc = workerConfig();
          if (reflectorUsage && wc) {
            const cost = estimateCost(
              wc.model,
              reflectorUsage.input_tokens,
              reflectorUsage.output_tokens,
            );
            span.setAttributes({
              input_tokens: reflectorUsage.input_tokens,
              output_tokens: reflectorUsage.output_tokens,
              cost_usd: cost,
            });
          }
          span.setOutput({
            kept: obsAfter.map((o) => `[${o.priority}] ${o.content}`),
            dropped: dropped.map((o) => `[${o.priority}] ${o.content}`),
          });
        }
      });
    }
  } catch (err) {
    agentLog.error`Post-response observation failed: ${err}`;
  }
}

/**
 * Fire-and-forget skill extraction from observations.
 * Reads active observations and extracts potential skills via LLM.
 * Runs independently of the memory pipeline (observations are already stored).
 */
async function runSkillExtraction(
  db: Kysely<Database>,
  opts: ProcessMessageOpts,
  memoryManager: ConstructMemoryManager,
  conversationId: string,
): Promise<void> {
  const activeObs = await memoryManager.getActiveObservations(conversationId);
  const extracted = await extractSkillsFromObservations(
    activeObs,
    env.OPENROUTER_API_KEY,
    env.EMBEDDING_MODEL,
  );

  if (extracted.length === 0) return;

  agentLog.info`Extracted ${extracted.length} potential skill(s) from observations`;

  if (opts.source !== "telegram" || !opts.chatId || opts.chatId === "unknown") return;

  const candidate = extracted
    .filter((s) => s.confidence >= 0.7)
    .toSorted((a, b) => b.confidence - a.confidence)[0];

  if (!candidate) return;

  const exists = await db
    .selectFrom("skills")
    .select("id")
    .where("name", "=", candidate.name)
    .executeTakeFirst();

  if (exists) return;

  const normalizedName = candidate.name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const ignoredAt = await getSetting(db, `ignored_skill:${normalizedName}`);
  const stillIgnored =
    ignoredAt && Date.now() - new Date(ignoredAt).getTime() < 7 * 24 * 60 * 60 * 1000;
  if (stillIgnored) return;

  const lastNudge = await getSetting(db, `skill_nudge_cooldown:${opts.chatId}`);
  const onCooldown = lastNudge && Date.now() - new Date(lastNudge).getTime() < 24 * 60 * 60 * 1000;
  if (onCooldown) return;

  const payload = JSON.stringify({
    name: candidate.name,
    description: candidate.description,
    body: candidate.body,
  });
  await setSetting(db, `skill_nudge:${opts.chatId}`, payload);
  await setSetting(db, `skill_nudge_cooldown:${opts.chatId}`, new Date().toISOString());
  agentLog.info`Queued skill nudge for chat ${opts.chatId}: "${candidate.name}"`;
}
