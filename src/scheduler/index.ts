import { Cron } from 'croner'
import type { Kysely } from 'kysely'
import type { Bot } from 'grammy'
import { listSchedules, markScheduleRun, cancelSchedule } from '../db/queries.js'
import { schedulerLog } from '../logger.js'
import type { Database, Schedule } from '../db/schema.js'

const activeJobs = new Map<string, Cron>()

export async function startScheduler(db: Kysely<Database>, bot: Bot) {
  schedulerLog.info`Starting scheduler`

  const schedules = await listSchedules(db, true)
  for (const schedule of schedules) {
    registerJob(db, bot, schedule)
  }

  schedulerLog.info`Loaded ${schedules.length} active schedules`

  // Poll for new schedules every 30 seconds
  setInterval(async () => {
    await syncSchedules(db, bot)
  }, 30_000)
}

export function registerJob(
  db: Kysely<Database>,
  bot: Bot,
  schedule: Schedule,
) {
  if (activeJobs.has(schedule.id)) return

  if (schedule.cron_expression) {
    schedulerLog.info`Registering cron job [${schedule.id}]: ${schedule.description} (${schedule.cron_expression})`
    const job = new Cron(schedule.cron_expression, async () => {
      await fireSchedule(db, bot, schedule)
    })
    activeJobs.set(schedule.id, job)
  } else if (schedule.run_at) {
    const runAt = new Date(schedule.run_at)
    const now = new Date()

    if (runAt <= now) {
      schedulerLog.info`Schedule [${schedule.id}] is past due, firing immediately`
      fireSchedule(db, bot, schedule).then(() =>
        cancelSchedule(db, schedule.id),
      )
      return
    }

    schedulerLog.info`Registering one-shot job [${schedule.id}]: ${schedule.description} at ${schedule.run_at}`
    const job = new Cron(runAt, async () => {
      await fireSchedule(db, bot, schedule)
      await cancelSchedule(db, schedule.id)
      activeJobs.delete(schedule.id)
    })
    activeJobs.set(schedule.id, job)
  }
}

async function fireSchedule(
  db: Kysely<Database>,
  bot: Bot,
  schedule: Schedule,
) {
  schedulerLog.info`Firing schedule [${schedule.id}]: ${schedule.description} → chat ${schedule.chat_id}`
  try {
    await bot.api.sendMessage(schedule.chat_id, schedule.message)
    await markScheduleRun(db, schedule.id)
    schedulerLog.info`Schedule [${schedule.id}] fired successfully`
  } catch (err) {
    schedulerLog.error`Failed to fire schedule [${schedule.id}]: ${err}`
  }
}

async function syncSchedules(db: Kysely<Database>, bot: Bot) {
  const schedules = await listSchedules(db, true)
  const activeIds = new Set(schedules.map((s) => s.id))

  for (const schedule of schedules) {
    if (!activeJobs.has(schedule.id)) {
      registerJob(db, bot, schedule)
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
  for (const [id, job] of activeJobs) {
    job.stop()
    activeJobs.delete(id)
  }
  schedulerLog.info`Scheduler stopped`
}
