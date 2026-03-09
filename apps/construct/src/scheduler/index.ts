import { Cron } from 'croner'
import type { Kysely } from 'kysely'
import type { Bot } from 'grammy'
import { listSchedules, markScheduleRun, cancelSchedule, getOrCreateConversation, saveMessage } from '../db/queries.js'
import { schedulerLog } from '../logger.js'
import type { Database, Schedule } from '../db/schema.js'
import { processMessage } from '../agent.js'
import { markdownToTelegramHtml } from '../telegram/format.js'

const activeJobs = new Map<string, Cron>()
let syncInterval: ReturnType<typeof setInterval> | null = null

export async function startScheduler(db: Kysely<Database>, bot: Bot, timezone: string) {
  schedulerLog.info`Starting scheduler (timezone: ${timezone})`

  const schedules = await listSchedules(db, true)
  for (const schedule of schedules) {
    registerJob(db, bot, schedule, timezone)
  }

  schedulerLog.info`Loaded ${schedules.length} active schedules`

  // Poll for new schedules every 30 seconds
  syncInterval = setInterval(async () => {
    await syncSchedules(db, bot, timezone)
  }, 30_000)
}

export function registerJob(
  db: Kysely<Database>,
  bot: Bot,
  schedule: Schedule,
  timezone: string,
) {
  if (activeJobs.has(schedule.id)) return

  if (schedule.cron_expression) {
    schedulerLog.info`Registering cron job [${schedule.id}]: ${schedule.description} (${schedule.cron_expression}) [${timezone}]`
    const job = new Cron(schedule.cron_expression, { timezone }, async () => {
      await fireSchedule(db, bot, schedule)
    })
    activeJobs.set(schedule.id, job)
  } else if (schedule.run_at) {
    schedulerLog.info`Registering one-shot job [${schedule.id}]: ${schedule.description} at ${schedule.run_at} [${timezone}]`
    const job = new Cron(schedule.run_at, { timezone }, async () => {
      await fireSchedule(db, bot, schedule)
      await cancelSchedule(db, schedule.id)
      activeJobs.delete(schedule.id)
    })

    // If nextRun is null, the time is in the past — fire immediately
    if (job.nextRun() === null) {
      job.stop()
      schedulerLog.info`Schedule [${schedule.id}] is past due, firing immediately`
      fireSchedule(db, bot, schedule).then(() =>
        cancelSchedule(db, schedule.id),
      )
      return
    }

    activeJobs.set(schedule.id, job)
  }
}

async function fireSchedule(
  db: Kysely<Database>,
  bot: Bot,
  schedule: Schedule,
) {
  await fireAgentSchedule(db, bot, schedule)
}

async function fireAgentSchedule(
  db: Kysely<Database>,
  bot: Bot,
  schedule: Schedule,
) {
  const instruction = schedule.prompt ?? schedule.message
  schedulerLog.info`Firing agent schedule [${schedule.id}]: ${schedule.description} → instruction: "${instruction}"`
  try {
    // Frame the instruction so the agent knows this schedule is firing NOW
    // and should execute/deliver it, not re-schedule it.
    const framedInstruction = [
      `[Scheduled task "${schedule.description}" is firing now. Execute the instruction — do not re-schedule it.]`,
      instruction,
    ].join('\n')

    const response = await processMessage(db, framedInstruction, {
      source: 'scheduler',
      externalId: `schedule:${schedule.id}`,
      chatId: schedule.chat_id,
    })
    await markScheduleRun(db, schedule.id)

    const text = response.text.trim()
    if (text) {
      // Send agent response to Telegram
      try {
        await bot.api.sendMessage(schedule.chat_id, markdownToTelegramHtml(text), {
          parse_mode: 'HTML',
        })
      } catch {
        // HTML parse failed — send as plain text
        await bot.api.sendMessage(schedule.chat_id, text)
      }

      // Mirror to user's telegram conversation history
      try {
        const conversationId = await getOrCreateConversation(db, 'telegram', schedule.chat_id)
        await saveMessage(db, {
          conversation_id: conversationId,
          role: 'assistant',
          content: `[Scheduled: ${schedule.description}] ${text}`,
        })
      } catch (saveErr) {
        schedulerLog.error`Failed to save agent schedule message to history [${schedule.id}]: ${saveErr}`
      }

      schedulerLog.info`Agent schedule [${schedule.id}] fired, response delivered (${text.length} chars)`
    } else {
      schedulerLog.info`Agent schedule [${schedule.id}] fired silently (empty response)`
    }
  } catch (err) {
    schedulerLog.error`Agent schedule [${schedule.id}] failed: ${err}`
  }
}

async function syncSchedules(db: Kysely<Database>, bot: Bot, timezone: string) {
  const schedules = await listSchedules(db, true)
  const activeIds = new Set(schedules.map((s) => s.id))

  for (const schedule of schedules) {
    if (!activeJobs.has(schedule.id)) {
      registerJob(db, bot, schedule, timezone)
    }
  }

  for (const [id, job] of activeJobs) {
    if (!activeIds.has(id)) {
      schedulerLog.info`Removing cancelled schedule [${id}]`
      job.stop()
      activeJobs.delete(id)
    }
  }
}

export function stopScheduler() {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
  for (const [id, job] of activeJobs) {
    job.stop()
    activeJobs.delete(id)
  }
  schedulerLog.info`Scheduler stopped`
}
