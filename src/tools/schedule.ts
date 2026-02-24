import { Type, type Static } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import {
  createSchedule,
  listSchedules,
  cancelSchedule,
} from '../db/queries.js'
import type { Database } from '../db/schema.js'
import { toolLog } from '../logger.js'

// --- schedule_create ---

const ScheduleCreateParams = Type.Object({
  description: Type.String({
    description: 'Human-readable description (e.g. "Dentist appointment reminder")',
  }),
  message: Type.String({
    description: 'The message to send when the schedule triggers',
  }),
  cron_expression: Type.Optional(
    Type.String({
      description:
        'Cron expression for recurring schedules (e.g. "0 9 * * 1" for every Monday at 9am). Uses the user\'s configured timezone.',
    }),
  ),
  run_at: Type.Optional(
    Type.String({
      description: 'ISO timestamp for one-shot schedules (e.g. "2025-03-05T09:00:00Z")',
    }),
  ),
})

type ScheduleCreateInput = Static<typeof ScheduleCreateParams>

/**
 * chatId is auto-injected from conversation context — the LLM never needs to know it.
 */
export function createScheduleCreateTool(db: Kysely<Database>, chatId: string) {
  return {
    name: 'schedule_create',
    description:
      'Create a scheduled reminder for the current user. Either provide a cron_expression for recurring reminders, or run_at for a one-shot reminder. The chat_id is automatically set — you do not need to provide it.',
    parameters: ScheduleCreateParams,
    execute: async (_toolCallId: string, args: ScheduleCreateInput) => {
      if (!args.cron_expression && !args.run_at) {
        return {
          output:
            'Please provide either a cron_expression (recurring) or run_at (one-shot).',
          details: {},
        }
      }

      toolLog.info`Creating schedule: ${args.description} for chat ${chatId}`

      const schedule = await createSchedule(db, {
        description: args.description,
        message: args.message,
        chat_id: chatId,
        cron_expression: args.cron_expression ?? null,
        run_at: args.run_at ?? null,
      })

      const type = schedule.cron_expression ? 'recurring' : 'one-shot'
      const when = schedule.cron_expression ?? schedule.run_at

      toolLog.info`Created ${type} schedule [${schedule.id}]: ${args.description} — ${when}`

      return {
        output: `Created ${type} schedule [${schedule.id}]: "${schedule.description}" — ${when}`,
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

export function createScheduleListTool(db: Kysely<Database>) {
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
        const type = s.cron_expression ? `cron: ${s.cron_expression}` : `at: ${s.run_at}`
        const status = s.active ? 'active' : 'inactive'
        return `[${s.id}] (${status}) ${s.description} — ${type}`
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
