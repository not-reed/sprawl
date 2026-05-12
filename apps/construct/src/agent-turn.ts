import { Agent, type AgentTool, type AgentToolResult } from "@mariozechner/pi-agent-core";
import { getModel, type Usage, type ToolResultMessage } from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import { estimateTokens } from "@repo/cairn";
import { env } from "./env.js";
import { agentLog, toolLog } from "./logger.js";
import { startActiveSpan } from "./tracing.js";
import { saveMessage } from "./db/queries.js";
import { getSystemPrompt } from "./system-prompt.js";
import type { Database } from "./db/schema.js";
import { createAllTools, type InternalTool } from "./tools/packs.js";
import { getExtensionRegistry, selectAndCreateDynamicTools } from "./extensions/index.js";
import type {
  AssembledContext,
  ProcessMessageOpts,
  TurnResult,
  AgentResponse,
} from "./agent-types.js";

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

interface ToolBundle {
  tools: InternalTool<TSchema>[];
  agent: Agent;
}

function buildAgent(
  opts: ProcessMessageOpts,
  ctx: AssembledContext,
  db: Kysely<Database>,
  isDev: boolean,
): ToolBundle {
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

  return { tools, agent };
}

function loadHistoryMessages(agent: Agent, ctx: AssembledContext): void {
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

      // Rehydrate tool results so continuation turns see prior tool executions.
      if ("tool_calls" in msg && msg.tool_calls) {
        try {
          const calls = JSON.parse(msg.tool_calls) as AgentResponse["toolCalls"];
          for (const call of calls) {
            if (!call.id) continue; // skip legacy tool calls without ids
            agent.state.messages = [
              ...agent.state.messages,
              {
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: "text", text: String(call.result) }],
                isError: false,
                timestamp: Date.now(),
              } satisfies ToolResultMessage,
            ];
          }
        } catch {
          // ignore malformed tool_calls JSON
        }
      }
    }
  }
}

interface TurnAccumulator {
  responseText: string;
  toolCalls: AgentResponse["toolCalls"];
  totalUsage: { input: number; output: number; cost: number };
  hasUsage: boolean;
  toolErrors: Array<{ toolName: string; result: string }>;
  toolSuccesses: number;
}

function attachAgentSubscribers(agent: Agent, acc: TurnAccumulator): void {
  const toolCallArgs = new Map<string, unknown>();

  agent.subscribe((event) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        acc.responseText += event.assistantMessageEvent.delta;
      }
    }
    if (event.type === "message_end") {
      const msg = event.message;
      if ("usage" in msg) {
        const u = msg.usage as Usage;
        acc.totalUsage.input += u.input;
        acc.totalUsage.output += u.output;
        acc.totalUsage.cost += u.cost.total;
        acc.hasUsage = true;
      }
    }
    if (event.type === "tool_execution_start") {
      toolCallArgs.set(event.toolCallId, event.args);
    }
    if (event.type === "tool_execution_end") {
      acc.toolCalls.push({
        id: event.toolCallId,
        name: event.toolName,
        args: toolCallArgs.get(event.toolCallId),
        result: String(event.result),
      });
      toolCallArgs.delete(event.toolCallId);
      if (event.isError) {
        acc.toolErrors.push({ toolName: event.toolName, result: String(event.result) });
      } else {
        acc.toolSuccesses++;
      }
    }
  });
}

function logContextBreakdown(ctx: AssembledContext, toolCount: number): void {
  const { identity } = getExtensionRegistry();
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
  const preambleTokens = estimateTokens(ctx.preamble);
  const totalContextTokens =
    systemTokens +
    observationTokens +
    recentMemTokens +
    relevantMemTokens +
    instructionTokens +
    historyTokens +
    preambleTokens;

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
}

export interface ExecuteTurnArgs {
  db: Kysely<Database>;
  message: string;
  opts: ProcessMessageOpts;
  ctx: AssembledContext;
  isDev: boolean;
  overridePrompt?: string;
}

export async function executeTurn(args: ExecuteTurnArgs): Promise<TurnResult> {
  const { db, message, opts, ctx, isDev, overridePrompt } = args;
  const { tools, agent } = buildAgent(opts, ctx, db, isDev);
  loadHistoryMessages(agent, ctx);

  const acc: TurnAccumulator = {
    responseText: "",
    toolCalls: [],
    totalUsage: { input: 0, output: 0, cost: 0 },
    hasUsage: false,
    toolErrors: [],
    toolSuccesses: 0,
  };
  attachAgentSubscribers(agent, acc);

  if (overridePrompt) {
    // Continuation turn — inject the prompt directly without saving a new
    // user message to the DB (the original message is already persisted).
    agentLog.debug`Injecting continuation prompt`;
  } else {
    await saveMessage(db, {
      conversation_id: ctx.conversationId,
      role: "user",
      content: message,
      telegram_message_id: opts.incomingTelegramMessageId ?? null,
    });
  }

  logContextBreakdown(ctx, tools.length);

  const promptText = overridePrompt ?? ctx.preamble + message;
  agentLog.debug`Prompting agent`;
  const llmSpan = startActiveSpan({
    name: "llm_call",
    spanType: "LLM",
    input: { prompt: promptText, model: env.OPENROUTER_MODEL },
  });
  await agent.prompt(promptText);
  await agent.waitForIdle();
  llmSpan.setAttributes({
    output: acc.responseText,
    input_tokens: acc.totalUsage.input,
    output_tokens: acc.totalUsage.output,
    cost_usd: acc.totalUsage.cost,
    tool_call_count: acc.toolCalls.length,
  });
  llmSpan.end();
  agentLog.info`Agent finished. Response length: ${acc.responseText.length}, tool calls: ${acc.toolCalls.length}`;

  acc.responseText = acc.responseText.replace(/\[tg:\d+\]\s*/g, "");
  acc.responseText = acc.responseText.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*/gm, "");

  return acc;
}
