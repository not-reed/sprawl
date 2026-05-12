import type { Kysely } from "kysely";
import type { Database } from "./db/schema.js";
import { upsertNode, upsertEdge, type WorkerModelConfig } from "@repo/cairn";
import { extractSkillsFromObservations } from "./skills/discovery.js";
import { ConstructMemoryManager } from "./memory.js";
import { env } from "./env.js";
import { getSetting, setSetting } from "./db/queries.js";
import { withSpan } from "./tracing.js";
import { agentLog } from "./logger.js";
import { estimateCost } from "./model-pricing.js";
import type {
  AgentResponse,
  ProcessMessageOpts,
  AssembledContext,
  TurnResult,
} from "./agent-types.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SKILL_NUDGE_CONFIDENCE = 0.7;

async function recordSuccessEdges(
  db: Kysely<Database>,
  eventNodeId: string,
  instrNodeIds: Map<string, string>,
  eventNodeName: string,
): Promise<void> {
  for (const graphNodeId of instrNodeIds.values()) {
    await upsertEdge(db, {
      source_id: graphNodeId,
      target_id: eventNodeId,
      relation: "applied_in",
    });
  }
  agentLog.debug`Created applied_in edges: ${instrNodeIds.size} instructions → ${eventNodeName}`;
}

interface FailureEdgeArgs {
  db: Kysely<Database>;
  eventNodeId: string;
  conversationId: string;
  selectedInstructionIds: string[];
  instrNodeIds: Map<string, string>;
  toolErrors: TurnResult["toolErrors"];
  eventNodeName: string;
}

async function recordFailureEdges(args: FailureEdgeArgs): Promise<void> {
  const {
    db,
    eventNodeId,
    conversationId,
    selectedInstructionIds,
    instrNodeIds,
    toolErrors,
    eventNodeName,
  } = args;
  const executions = await db
    .selectFrom("skill_executions")
    .where("conversation_id", "=", conversationId)
    .where("implicated_instruction_id", "is not", null)
    .where("had_tool_errors", "=", 1)
    .select("implicated_instruction_id")
    .execute();

  const implicatedIds = new Set(
    executions.map((e) => e.implicated_instruction_id).filter((id): id is string => id != null),
  );

  const failedIds = implicatedIds.size > 0 ? implicatedIds : new Set(selectedInstructionIds);
  const errorSummary = toolErrors.map((e) => `${e.toolName}: ${e.result.slice(0, 100)}`).join("; ");

  for (const instrId of failedIds) {
    const graphNodeId = instrNodeIds.get(instrId);
    if (graphNodeId) {
      await upsertEdge(db, {
        source_id: graphNodeId,
        target_id: eventNodeId,
        relation: "failed_on",
        properties: { errors: errorSummary },
      });
    }
  }
  agentLog.debug`Created failed_on edges: ${failedIds.size} instructions → ${eventNodeName}`;
}

async function recordSkillGraphEdges(
  db: Kysely<Database>,
  conversationId: string,
  selectedInstructionIds: string[],
  result: TurnResult,
  assistantMessageId: string,
): Promise<void> {
  if (selectedInstructionIds.length === 0 || result.toolCalls.length === 0) return;

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
      await recordSuccessEdges(db, eventNode.id, instrNodeIds, eventNodeName);
    }

    if (result.toolErrors.length > 0) {
      await recordFailureEdges({
        db,
        eventNodeId: eventNode.id,
        conversationId,
        selectedInstructionIds,
        instrNodeIds,
        toolErrors: result.toolErrors,
        eventNodeName,
      });
    }
  } catch (err) {
    agentLog.warning`Failed to create skill instruction graph edges: ${err}`;
  }
}

async function runReflectorWithSpan(
  memoryManager: ConstructMemoryManager,
  conversationId: string,
  workerConfig: WorkerModelConfig | null,
): Promise<void> {
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

    if (!reflectorRan) return;

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
    if (reflectorUsage && workerConfig) {
      const cost = estimateCost(
        workerConfig.model,
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
  });
}

export async function runSkillExtraction(
  db: Kysely<Database>,
  memoryManager: ConstructMemoryManager,
  conversationId: string,
  source: string,
  chatId?: string,
): Promise<void> {
  const activeObs = await memoryManager.getActiveObservations(conversationId);
  const extracted = await extractSkillsFromObservations(
    activeObs,
    env.OPENROUTER_API_KEY,
    env.EMBEDDING_MODEL,
  );

  if (extracted.length === 0) return;
  agentLog.info`Extracted ${extracted.length} potential skill(s) from observations`;

  if (source !== "telegram" || !chatId || chatId === "unknown") return;

  const candidate = extracted
    .filter((s) => s.confidence >= SKILL_NUDGE_CONFIDENCE)
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
  const stillIgnored = ignoredAt && Date.now() - new Date(ignoredAt).getTime() < SEVEN_DAYS_MS;
  if (stillIgnored) return;

  const lastNudge = await getSetting(db, `skill_nudge_cooldown:${chatId}`);
  const onCooldown = lastNudge && Date.now() - new Date(lastNudge).getTime() < ONE_DAY_MS;
  if (onCooldown) return;

  const payload = JSON.stringify({
    name: candidate.name,
    description: candidate.description,
    body: candidate.body,
  });
  await setSetting(db, `skill_nudge:${chatId}`, payload);
  await setSetting(db, `skill_nudge_cooldown:${chatId}`, new Date().toISOString());
  agentLog.info`Queued skill nudge for chat ${chatId}: "${candidate.name}"`;
}

async function runMemoryPipelineInline(
  db: Kysely<Database>,
  opts: ProcessMessageOpts,
  memoryManager: ConstructMemoryManager,
  conversationId: string,
  workerConfig: WorkerModelConfig | null,
): Promise<void> {
  const ran = await memoryManager.runObserver(conversationId);
  if (ran) {
    await memoryManager.promoteObservations(conversationId);
    await runSkillExtraction(db, memoryManager, conversationId, opts.source, opts.chatId).catch(
      (err: unknown) => agentLog.warning`Failed to extract skills from observations: ${err}`,
    );
  }
  await runReflectorWithSpan(memoryManager, conversationId, workerConfig);
}

export interface PostTurnArgs {
  db: Kysely<Database>;
  opts: ProcessMessageOpts;
  ctx: AssembledContext;
  result: TurnResult;
  assistantMessageId: string;
  workerConfig: WorkerModelConfig | null;
}

export async function runPostTurn(args: PostTurnArgs): Promise<void> {
  const { db, opts, ctx, result, assistantMessageId, workerConfig } = args;
  await recordSkillGraphEdges(
    db,
    ctx.conversationId,
    ctx.selectedInstructionIds,
    result,
    assistantMessageId,
  );

  try {
    if (opts.pipelineQueue) {
      opts.pipelineQueue
        .enqueue("post_turn", ctx.conversationId)
        .catch((err: unknown) => agentLog.error`Pipeline enqueue failed: ${err}`);
      return;
    }

    await runMemoryPipelineInline(db, opts, ctx.memoryManager, ctx.conversationId, workerConfig);
  } catch (err) {
    agentLog.error`Post-response observation failed: ${err}`;
  }
}

// Re-export AgentResponse to keep sibling modules' import surface flat.
export type { AgentResponse };
