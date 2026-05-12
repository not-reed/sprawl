import type { Kysely } from "kysely";
import { generateEmbedding, cosineSimilarity } from "@repo/cairn";
import { createSchedule, listSchedules, cancelSchedule } from "../../db/queries.js";
import type { Database, Schedule } from "../../db/schema.js";
import { toolLog } from "../../logger.js";

export interface ScheduleContext {
  db: Kysely<Database>;
  chatId: string;
  timezone: string;
  apiKey: string;
  embeddingModel?: string;
}

export interface ScheduleArgs {
  action: string;
  description?: string;
  instruction?: string;
  cron_expression?: string;
  run_at?: string;
  active_only?: boolean;
  id?: string;
}

export interface HandlerResult {
  output: string;
  details?: unknown;
}

function stripTimezoneOffset(datetime: string): string {
  return datetime.replace(/[Zz]$|[+-]\d{2}:\d{2}$/, "");
}

function normalizeForDedup(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

export function isSimilarMessage(a: string, b: string, threshold = 0.75): boolean {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  if (na === nb) return true;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return true;
  return 1 - levenshtein(na, nb) / maxLen >= threshold;
}

function getTimeCandidates(
  existing: Schedule[],
  chatId: string,
  cronExpression: string | undefined,
  normalizedRunAt: string | null,
): Schedule[] {
  return existing.filter((s) => {
    if (s.chat_id !== chatId) return false;
    if (cronExpression && s.cron_expression === cronExpression) return true;
    if (normalizedRunAt && s.run_at === normalizedRunAt) return true;
    return false;
  });
}

function findFastDuplicate(
  candidates: Schedule[],
  description: string,
  instruction: string,
): Schedule | undefined {
  return candidates.find((s) => {
    const existingInstruction = s.prompt ?? s.message;
    if (isSimilarMessage(existingInstruction, instruction)) return true;
    if (isSimilarMessage(s.description, description)) return true;
    return false;
  });
}

async function findEmbeddingDuplicate(
  candidates: Schedule[],
  description: string,
  apiKey: string,
  embeddingModel?: string,
  threshold = 0.7,
): Promise<Schedule | undefined> {
  if (candidates.length === 0) return undefined;
  try {
    const [newEmb, ...existingEmbs] = await Promise.all([
      generateEmbedding(apiKey, description, embeddingModel),
      ...candidates.map((s) => generateEmbedding(apiKey, s.description, embeddingModel)),
    ]);
    for (let i = 0; i < candidates.length; i++) {
      const score = cosineSimilarity(newEmb!, existingEmbs[i]!);
      if (score >= threshold) {
        toolLog.info`Embedding dedup: "${description}" ≈ "${candidates[i]!.description}" (score=${score.toFixed(3)})`;
        return candidates[i];
      }
    }
  } catch (err) {
    toolLog.error`Embedding dedup failed, skipping: ${err}`;
  }
  return undefined;
}

async function findDuplicateSchedule(
  ctx: ScheduleContext,
  description: string,
  instruction: string,
  cronExpression: string | undefined,
  normalizedRunAt: string | null,
): Promise<Schedule | undefined> {
  const existing = await listSchedules(ctx.db, true);
  const candidates = getTimeCandidates(existing, ctx.chatId, cronExpression, normalizedRunAt);

  const fast = findFastDuplicate(candidates, description, instruction);
  if (fast) return fast;
  if (candidates.length === 0) return undefined;

  return findEmbeddingDuplicate(candidates, description, ctx.apiKey, ctx.embeddingModel);
}

export async function handleCreate(
  ctx: ScheduleContext,
  args: ScheduleArgs,
): Promise<HandlerResult> {
  if (!args.description || !args.instruction) {
    return {
      output: 'The "create" action requires "description" and "instruction" parameters.',
      details: { error: "missing_params" },
    };
  }
  if (!args.cron_expression && !args.run_at) {
    return {
      output: "Please provide either a cron_expression (recurring) or run_at (one-shot).",
      details: {},
    };
  }

  const normalizedRunAt = args.run_at ? stripTimezoneOffset(args.run_at) : null;

  const duplicate = await findDuplicateSchedule(
    ctx,
    args.description,
    args.instruction,
    args.cron_expression,
    normalizedRunAt,
  );

  if (duplicate) {
    const type = duplicate.cron_expression ? "recurring" : "one-shot";
    const when = duplicate.cron_expression ?? duplicate.run_at;
    toolLog.info`Dedup: returning existing schedule [${duplicate.id}] instead of creating duplicate`;
    return {
      output: `Schedule already exists — ${type} [${duplicate.id}]: "${duplicate.description}" — ${when} (${ctx.timezone})`,
      details: { schedule: duplicate, deduplicated: true },
    };
  }

  toolLog.info`Creating schedule: ${args.description} for chat ${ctx.chatId}`;

  const schedule = await createSchedule(ctx.db, {
    description: args.description,
    message: args.description,
    prompt: args.instruction,
    chat_id: ctx.chatId,
    cron_expression: args.cron_expression ?? null,
    run_at: normalizedRunAt,
  });

  const type = schedule.cron_expression ? "recurring" : "one-shot";
  const when = schedule.cron_expression ?? schedule.run_at;
  toolLog.info`Created ${type} schedule [${schedule.id}]: ${args.description} — ${when}`;

  return {
    output: `Created ${type} schedule [${schedule.id}]: "${schedule.description}" — ${when} (${ctx.timezone})`,
    details: { schedule },
  };
}

export async function handleList(ctx: ScheduleContext, args: ScheduleArgs): Promise<HandlerResult> {
  const schedules = await listSchedules(ctx.db, args.active_only ?? true);
  if (schedules.length === 0) {
    return { output: "No scheduled reminders found.", details: { schedules: [] } };
  }

  const lines = schedules.map((s) => {
    const sType = s.cron_expression
      ? `cron: ${s.cron_expression}`
      : `at: ${s.run_at} (${ctx.timezone})`;
    const status = s.active ? "active" : "inactive";
    const badge = s.prompt ? " [agent]" : "";
    return `[${s.id}] (${status})${badge} ${s.description} — ${sType}`;
  });

  return {
    output: `${schedules.length} schedules:\n${lines.join("\n")}`,
    details: { schedules },
  };
}

export async function handleCancel(
  ctx: ScheduleContext,
  args: ScheduleArgs,
): Promise<HandlerResult> {
  if (!args.id) {
    return {
      output: 'The "cancel" action requires an "id" parameter.',
      details: { error: "missing_params" },
    };
  }

  const success = await cancelSchedule(ctx.db, args.id);
  if (success) {
    toolLog.info`Cancelled schedule [${args.id}]`;
    return { output: `Cancelled schedule [${args.id}].`, details: { cancelled: args.id } };
  }
  return {
    output: `Schedule [${args.id}] not found or already cancelled.`,
    details: { cancelled: null },
  };
}
