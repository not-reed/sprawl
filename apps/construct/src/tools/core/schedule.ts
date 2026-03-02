import { Type, type Static } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import { generateEmbedding, cosineSimilarity } from '@repo/cairn'
import {
  createSchedule,
  listSchedules,
  cancelSchedule,
} from '../../db/queries.js'
import type { Database, Schedule } from '../../db/schema.js'
import { toolLog } from '../../logger.js'

// --- helpers ---

/** Strip trailing Z or ±HH:MM offset from a datetime string so it's treated as local. */
function stripTimezoneOffset(datetime: string): string {
  return datetime.replace(/[Zz]$|[+-]\d{2}:\d{2}$/, '')
}

/** Normalize a string for dedup: lowercase, strip non-alphanumeric. */
function normalizeForDedup(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i)

  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = tmp
    }
  }

  return dp[n]
}

/** Check if two messages are similar enough to be considered duplicates. */
function isSimilarMessage(a: string, b: string, threshold = 0.75): boolean {
  const na = normalizeForDedup(a)
  const nb = normalizeForDedup(b)
  if (na === nb) return true
  const maxLen = Math.max(na.length, nb.length)
  if (maxLen === 0) return true
  return 1 - levenshtein(na, nb) / maxLen >= threshold
}

/** Filter existing schedules to those matching time + chat + mode. */
function getTimeCandidates(
  existing: Schedule[],
  chatId: string,
  isPromptMode: boolean,
  cronExpression: string | undefined,
  normalizedRunAt: string | null,
): Schedule[] {
  return existing.filter((s) => {
    if (s.chat_id !== chatId) return false
    if (!!s.prompt !== isPromptMode) return false
    if (cronExpression && s.cron_expression === cronExpression) return true
    if (normalizedRunAt && s.run_at === normalizedRunAt) return true
    return false
  })
}

/** Fast dedup: Levenshtein on message/prompt content + description. */
function findFastDuplicate(
  candidates: Schedule[],
  args: ScheduleCreateInput,
  isPromptMode: boolean,
): Schedule | undefined {
  return candidates.find((s) => {
    // Check message/prompt content (original behavior)
    if (isPromptMode) {
      if (isSimilarMessage(s.prompt!, args.prompt!)) return true
    } else {
      if (isSimilarMessage(s.message, args.message!)) return true
    }
    // Also check description similarity
    if (isSimilarMessage(s.description, args.description)) return true
    return false
  })
}

/** Slow dedup: embedding cosine similarity on descriptions. */
async function findEmbeddingDuplicate(
  candidates: Schedule[],
  description: string,
  apiKey: string,
  embeddingModel?: string,
  threshold = 0.7,
): Promise<Schedule | undefined> {
  if (candidates.length === 0) return undefined
  try {
    const [newEmb, ...existingEmbs] = await Promise.all([
      generateEmbedding(apiKey, description, embeddingModel),
      ...candidates.map((s) => generateEmbedding(apiKey, s.description, embeddingModel)),
    ])
    for (let i = 0; i < candidates.length; i++) {
      const score = cosineSimilarity(newEmb, existingEmbs[i])
      if (score >= threshold) {
        toolLog.info`Embedding dedup: "${description}" ≈ "${candidates[i].description}" (score=${score.toFixed(3)})`
        return candidates[i]
      }
    }
  } catch (err) {
    toolLog.error`Embedding dedup failed, skipping: ${err}`
  }
  return undefined
}

// --- schedule_create ---

const ScheduleCreateParams = Type.Object({
  description: Type.String({
    description: 'Human-readable description (e.g. "Dentist appointment reminder")',
  }),
  message: Type.Optional(
    Type.String({
      description: 'The static message to send when the schedule triggers. Required unless prompt is provided.',
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description: 'An agent prompt to run when the schedule triggers (with full tool access). Use this for conditional notifications, background tasks, or anything that needs reasoning. Mutually exclusive with message.',
    }),
  ),
  cron_expression: Type.Optional(
    Type.String({
      description:
        'Cron expression for recurring schedules (e.g. "0 9 * * 1" for every Monday at 9am). Uses the user\'s configured timezone.',
    }),
  ),
  run_at: Type.Optional(
    Type.String({
      description:
        "Datetime in user's local timezone, without Z or offset (e.g. '2025-03-05T09:00:00')",
    }),
  ),
})

type ScheduleCreateInput = Static<typeof ScheduleCreateParams>

/**
 * chatId is auto-injected from conversation context — the LLM never needs to know it.
 */
export function createScheduleCreateTool(
  db: Kysely<Database>,
  chatId: string,
  timezone: string,
  apiKey: string,
  embeddingModel?: string,
) {
  return {
    name: 'schedule_create',
    description:
      'Create a scheduled reminder or agent task. Use message for static reminders, or prompt for agent-executed tasks (with full tool access for conditional logic, web lookups, memory storage, etc.). Either provide a cron_expression for recurring, or run_at for one-shot.',
    parameters: ScheduleCreateParams,
    execute: async (_toolCallId: string, args: ScheduleCreateInput) => {
      if (!args.cron_expression && !args.run_at) {
        return {
          output:
            'Please provide either a cron_expression (recurring) or run_at (one-shot).',
          details: {},
        }
      }

      if (!args.message && !args.prompt) {
        return {
          output: 'Please provide either a message (static) or a prompt (agent-executed).',
          details: {},
        }
      }

      if (args.message && args.prompt) {
        return {
          output: 'Provide either message or prompt, not both.',
          details: {},
        }
      }

      const isPromptMode = !!args.prompt

      // Normalize run_at: strip any Z or offset the LLM may have added
      const normalizedRunAt = args.run_at ? stripTimezoneOffset(args.run_at) : null

      // Dedup: two-pass — fast Levenshtein, then embedding similarity for same-time schedules
      const existing = await listSchedules(db, true)
      const candidates = getTimeCandidates(existing, chatId, isPromptMode, args.cron_expression, normalizedRunAt)

      // Fast pass: Levenshtein on content + description (no API call)
      let duplicate = findFastDuplicate(candidates, args, isPromptMode)

      // Slow pass: embedding similarity on descriptions (only if fast pass missed)
      if (!duplicate && candidates.length > 0) {
        duplicate = await findEmbeddingDuplicate(candidates, args.description, apiKey, embeddingModel)
      }

      if (duplicate) {
        const type = duplicate.cron_expression ? 'recurring' : 'one-shot'
        const when = duplicate.cron_expression ?? duplicate.run_at
        const mode = duplicate.prompt ? 'agent-prompt' : 'static-message'
        toolLog.info`Dedup: returning existing schedule [${duplicate.id}] instead of creating duplicate`
        return {
          output: `Schedule already exists — ${type} ${mode} [${duplicate.id}]: "${duplicate.description}" — ${when} (${timezone})`,
          details: { schedule: duplicate, deduplicated: true },
        }
      }

      // For prompt mode, use description as the message (DB column is NOT NULL)
      const message = args.message ?? args.description

      toolLog.info`Creating schedule: ${args.description} for chat ${chatId}${isPromptMode ? ' (agent-prompt)' : ''}`

      const schedule = await createSchedule(db, {
        description: args.description,
        message,
        prompt: args.prompt ?? null,
        chat_id: chatId,
        cron_expression: args.cron_expression ?? null,
        run_at: normalizedRunAt,
      })

      const type = schedule.cron_expression ? 'recurring' : 'one-shot'
      const when = schedule.cron_expression ?? schedule.run_at
      const mode = isPromptMode ? 'agent-prompt' : 'static-message'

      toolLog.info`Created ${type} ${mode} schedule [${schedule.id}]: ${args.description} — ${when}`

      return {
        output: `Created ${type} ${mode} schedule [${schedule.id}]: "${schedule.description}" — ${when} (${timezone})`,
        details: { schedule },
      }
    },
  }
}

// --- schedule_list ---

const ScheduleListParams = Type.Object({
  active_only: Type.Optional(
    Type.Boolean({ description: 'Only show active schedules (default: true)' }),
  ),
})

type ScheduleListInput = Static<typeof ScheduleListParams>

export function createScheduleListTool(db: Kysely<Database>, timezone: string) {
  return {
    name: 'schedule_list',
    description: 'List all scheduled reminders.',
    parameters: ScheduleListParams,
    execute: async (_toolCallId: string, args: ScheduleListInput) => {
      const schedules = await listSchedules(db, args.active_only ?? true)

      if (schedules.length === 0) {
        return {
          output: 'No scheduled reminders found.',
          details: { schedules: [] },
        }
      }

      const lines = schedules.map((s) => {
        const type = s.cron_expression
          ? `cron: ${s.cron_expression}`
          : `at: ${s.run_at} (${timezone})`
        const status = s.active ? 'active' : 'inactive'
        const badge = s.prompt ? ' [agent]' : ''
        return `[${s.id}] (${status})${badge} ${s.description} — ${type}`
      })

      return {
        output: `${schedules.length} schedules:\n${lines.join('\n')}`,
        details: { schedules },
      }
    },
  }
}

// --- schedule_cancel ---

const ScheduleCancelParams = Type.Object({
  id: Type.String({ description: 'The schedule ID to cancel' }),
})

type ScheduleCancelInput = Static<typeof ScheduleCancelParams>

export function createScheduleCancelTool(db: Kysely<Database>) {
  return {
    name: 'schedule_cancel',
    description: 'Cancel (deactivate) a scheduled reminder.',
    parameters: ScheduleCancelParams,
    execute: async (_toolCallId: string, args: ScheduleCancelInput) => {
      const success = await cancelSchedule(db, args.id)

      if (success) {
        toolLog.info`Cancelled schedule [${args.id}]`
        return {
          output: `Cancelled schedule [${args.id}].`,
          details: { cancelled: args.id },
        }
      }

      return {
        output: `Schedule [${args.id}] not found or already cancelled.`,
        details: { cancelled: null },
      }
    },
  }
}
