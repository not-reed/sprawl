import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import { generateEmbedding, cosineSimilarity } from "@repo/cairn";
import { createSchedule, listSchedules, cancelSchedule } from "../../db/queries.js";
import type { Database, Schedule } from "../../db/schema.js";
import { toolLog } from "../../logger.js";

// --- helpers ---

/** Strip trailing Z or ±HH:MM offset from a datetime string so it's treated as local. */
function stripTimezoneOffset(datetime: string): string {
  return datetime.replace(/[Zz]$|[+-]\d{2}:\d{2}$/, "");
}

/** Normalize a string for dedup: lowercase, strip non-alphanumeric. */
function normalizeForDedup(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }

  return dp[n];
}

/** Check if two messages are similar enough to be considered duplicates. */
function isSimilarMessage(a: string, b: string, threshold = 0.75): boolean {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  if (na === nb) return true;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return true;
  return 1 - levenshtein(na, nb) / maxLen >= threshold;
}

/** Filter existing schedules to those matching time + chat. */
function getTimeCandidates(
  existing: Schedule[],
  chatId: string,
  _isPromptMode: boolean,
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

interface CreateArgs {
  description: string;
  instruction: string;
  cron_expression?: string;
  run_at?: string;
}

/** Fast dedup: Levenshtein on instruction/prompt content + description. */
function findFastDuplicate(candidates: Schedule[], args: CreateArgs): Schedule | undefined {
  return candidates.find((s) => {
    // Check prompt/message content against new instruction
    const existingInstruction = s.prompt ?? s.message;
    if (isSimilarMessage(existingInstruction, args.instruction)) return true;
    // Also check description similarity
    if (isSimilarMessage(s.description, args.description)) return true;
    return false;
  });
}

/** Slow dedup: embedding cosine similarity on descriptions. */
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
      const score = cosineSimilarity(newEmb, existingEmbs[i]);
      if (score >= threshold) {
        toolLog.info`Embedding dedup: "${description}" ≈ "${candidates[i].description}" (score=${score.toFixed(3)})`;
        return candidates[i];
      }
    }
  } catch (err) {
    toolLog.error`Embedding dedup failed, skipping: ${err}`;
  }
  return undefined;
}

// --- Unified schedule tool ---

const ScheduleParams = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel")], {
    description: 'Action: "create" a reminder, "list" existing reminders, "cancel" a reminder',
  }),
  description: Type.Optional(
    Type.String({ description: 'For "create": human-readable description of the reminder' }),
  ),
  instruction: Type.Optional(
    Type.String({ description: 'For "create": what the agent should do when the reminder fires' }),
  ),
  cron_expression: Type.Optional(
    Type.String({
      description: 'For "create": cron expression for recurring schedules (e.g. "0 9 * * 1")',
    }),
  ),
  run_at: Type.Optional(
    Type.String({
      description: 'For "create": datetime in local timezone, without Z or offset',
    }),
  ),
  active_only: Type.Optional(
    Type.Boolean({ description: 'For "list": only show active schedules (default: true)' }),
  ),
  id: Type.Optional(Type.String({ description: 'For "cancel": schedule ID to cancel' })),
});

type ScheduleInput = Static<typeof ScheduleParams>;

export function createScheduleTool(
  db: Kysely<Database>,
  chatId: string,
  timezone: string,
  apiKey: string,
  embeddingModel?: string,
) {
  return {
    name: "schedule" as const,
    description:
      'Schedule reminders and agent tasks. Actions: "create" (cron or one-shot), "list" existing, "cancel" by ID.',
    parameters: ScheduleParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as ScheduleInput;

      switch (typed.action) {
        case "create": {
          if (!typed.description || !typed.instruction) {
            return {
              output: 'The "create" action requires "description" and "instruction" parameters.',
              details: { error: "missing_params" },
            };
          }
          if (!typed.cron_expression && !typed.run_at) {
            return {
              output: "Please provide either a cron_expression (recurring) or run_at (one-shot).",
              details: {},
            };
          }

          const normalizedRunAt = typed.run_at ? stripTimezoneOffset(typed.run_at) : null;

          const existing = await listSchedules(db, true);
          const candidates = getTimeCandidates(
            existing,
            chatId,
            true,
            typed.cron_expression,
            normalizedRunAt,
          );

          let duplicate = findFastDuplicate(candidates, {
            description: typed.description,
            instruction: typed.instruction,
            cron_expression: typed.cron_expression,
            run_at: typed.run_at,
          });

          if (!duplicate && candidates.length > 0) {
            duplicate = await findEmbeddingDuplicate(
              candidates,
              typed.description,
              apiKey,
              embeddingModel,
            );
          }

          if (duplicate) {
            const type = duplicate.cron_expression ? "recurring" : "one-shot";
            const when = duplicate.cron_expression ?? duplicate.run_at;
            toolLog.info`Dedup: returning existing schedule [${duplicate.id}] instead of creating duplicate`;
            return {
              output: `Schedule already exists — ${type} [${duplicate.id}]: "${duplicate.description}" — ${when} (${timezone})`,
              details: { schedule: duplicate, deduplicated: true },
            };
          }

          toolLog.info`Creating schedule: ${typed.description} for chat ${chatId}`;

          const schedule = await createSchedule(db, {
            description: typed.description,
            message: typed.description,
            prompt: typed.instruction,
            chat_id: chatId,
            cron_expression: typed.cron_expression ?? null,
            run_at: normalizedRunAt,
          });

          const type = schedule.cron_expression ? "recurring" : "one-shot";
          const when = schedule.cron_expression ?? schedule.run_at;

          toolLog.info`Created ${type} schedule [${schedule.id}]: ${typed.description} — ${when}`;

          return {
            output: `Created ${type} schedule [${schedule.id}]: "${schedule.description}" — ${when} (${timezone})`,
            details: { schedule },
          };
        }

        case "list": {
          const schedules = await listSchedules(db, typed.active_only ?? true);

          if (schedules.length === 0) {
            return {
              output: "No scheduled reminders found.",
              details: { schedules: [] },
            };
          }

          const lines = schedules.map((s) => {
            const sType = s.cron_expression
              ? `cron: ${s.cron_expression}`
              : `at: ${s.run_at} (${timezone})`;
            const status = s.active ? "active" : "inactive";
            const badge = s.prompt ? " [agent]" : "";
            return `[${s.id}] (${status})${badge} ${s.description} — ${sType}`;
          });

          return {
            output: `${schedules.length} schedules:\n${lines.join("\n")}`,
            details: { schedules },
          };
        }

        case "cancel": {
          if (!typed.id) {
            return {
              output: 'The "cancel" action requires an "id" parameter.',
              details: { error: "missing_params" },
            };
          }

          const success = await cancelSchedule(db, typed.id);

          if (success) {
            toolLog.info`Cancelled schedule [${typed.id}]`;
            return {
              output: `Cancelled schedule [${typed.id}].`,
              details: { cancelled: typed.id },
            };
          }

          return {
            output: `Schedule [${typed.id}] not found or already cancelled.`,
            details: { cancelled: null },
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
