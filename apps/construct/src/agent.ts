import type { Kysely } from "kysely";

import { env } from "./env.js";
import { startActiveSpan } from "./tracing.js";
import { agentLog } from "./logger.js";
import type { Database } from "./db/schema.js";
import { saveMessage, trackUsage } from "./db/queries.js";
import { type WorkerModelConfig } from "@repo/cairn";

import { assembleContext } from "./agent-context.js";
import { executeTurn } from "./agent-turn.js";
import { runPostTurn } from "./agent-post-turn.js";
import { checkCompletion, MAX_CONTINUATIONS } from "./completion-check.js";
import type {
  AgentResponse,
  AssembledContext,
  ProcessMessageOpts,
  TurnResult,
} from "./agent-types.js";

export type { AgentResponse, ProcessMessageOpts } from "./agent-types.js";

const workerConfig = (): WorkerModelConfig | null =>
  env.MEMORY_WORKER_MODEL
    ? {
        apiKey: env.OPENROUTER_API_KEY,
        model: env.MEMORY_WORKER_MODEL,
        baseUrl: env.OPENROUTER_BASE_URL,
        extraBody: { reasoning: { max_tokens: 1 } },
      }
    : null;

export const isDev = env.NODE_ENV === "development";

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

/** Simple continuation prompt injected when the agent stops early. */
const CONTINUATION_PROMPT =
  "Continue — you haven't finished yet. Keep working on the current task until it's fully complete.";

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

  const wc = workerConfig();

  try {
    const ctx = await assembleContext({ db, message, opts, rootSpan, workerConfig: wc, isDev });
    let result = await executeTurn({ db, message, opts, ctx, isDev });

    // Accumulate across continuation turns so only a single assistant message
    // is persisted to the DB (avoids back-to-back assistant messages on next turn).
    let accumulatedResponseText = result.responseText;
    let accumulatedToolCalls = [...result.toolCalls];
    let accumulatedToolErrors = [...result.toolErrors];
    let accumulatedToolSuccesses = result.toolSuccesses;
    let accumulatedInput = result.totalUsage.input;
    let accumulatedOutput = result.totalUsage.output;
    let accumulatedCost = result.totalUsage.cost;
    let hasUsage = result.hasUsage;

    // Loop interception: if the agent stopped early, force a continuation.
    let continuationCount = 0;
    for (let i = 1; i <= MAX_CONTINUATIONS; i++) {
      const check = checkCompletion(message, result, accumulatedResponseText, {
        toolErrorCount: accumulatedToolErrors.length,
        toolSuccessCount: accumulatedToolSuccesses,
      });
      if (check.complete) break;

      agentLog.info`Continuation ${i}: ${check.reason}`;
      continuationCount++;

      // Keep context continuity by appending the previous assistant response
      // to the in-memory history (no DB re-assembly needed).
      ctx.historyMessages = [
        ...ctx.historyMessages,
        {
          role: "assistant",
          content: result.responseText,
          created_at: new Date().toISOString(),
          tool_calls: result.toolCalls.length > 0 ? JSON.stringify(result.toolCalls) : undefined,
        },
      ];

      result = await executeTurn({
        db,
        message,
        opts,
        ctx,
        isDev,
        overridePrompt: CONTINUATION_PROMPT,
      });

      accumulatedResponseText += "\n\n" + result.responseText;
      accumulatedToolCalls.push(...result.toolCalls);
      accumulatedToolErrors.push(...result.toolErrors);
      accumulatedToolSuccesses += result.toolSuccesses;
      if (result.hasUsage) {
        accumulatedInput += result.totalUsage.input;
        accumulatedOutput += result.totalUsage.output;
        accumulatedCost += result.totalUsage.cost;
        hasUsage = true;
      }
    }

    const finalResult: TurnResult = {
      ...result,
      responseText: accumulatedResponseText,
      toolCalls: accumulatedToolCalls,
      toolErrors: accumulatedToolErrors,
      toolSuccesses: accumulatedToolSuccesses,
      totalUsage: { input: accumulatedInput, output: accumulatedOutput, cost: accumulatedCost },
      hasUsage,
    };

    const assistantMessageId = await persistTurn(db, opts, ctx, finalResult);

    runPostTurn({ db, opts, ctx, result: finalResult, assistantMessageId, workerConfig: wc }).catch(
      (err: unknown) => agentLog.error`Post-turn pipeline failed: ${err}`,
    );

    const usage = hasUsage ? finalResult.totalUsage : undefined;

    rootSpan.setAttributes({
      output: finalResult.responseText,
      tool_call_count: finalResult.toolCalls.length,
      continuation_count: continuationCount,
      ...(hasUsage
        ? {
            input_tokens: finalResult.totalUsage.input,
            output_tokens: finalResult.totalUsage.output,
            cost_usd: finalResult.totalUsage.cost,
          }
        : {}),
    });

    return {
      text: finalResult.responseText,
      toolCalls: finalResult.toolCalls,
      usage,
      messageId: assistantMessageId,
    };
  } finally {
    rootSpan.end();
  }
}
