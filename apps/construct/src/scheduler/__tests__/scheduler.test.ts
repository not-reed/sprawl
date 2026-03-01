import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database, Schedule } from '../../db/schema.js'
import { setupDb } from '../../__tests__/fixtures.js'
import { registerJob, stopScheduler } from '../index.js'
import { listSchedules, cancelSchedule, markScheduleRun } from '../../db/queries.js'
import { nanoid } from 'nanoid'

let db: Kysely<Database>

/** Insert a schedule directly into the DB. */
async function insertSchedule(
  db: Kysely<Database>,
  overrides: Partial<Schedule> & Pick<Schedule, 'message' | 'chat_id'>,
): Promise<Schedule> {
  const id = overrides.id ?? nanoid()
  await db
    .insertInto('schedules')
    .values({
      id,
      description: overrides.description ?? 'test schedule',
      cron_expression: overrides.cron_expression ?? null,
      run_at: overrides.run_at ?? null,
      message: overrides.message,
      chat_id: overrides.chat_id,
    })
    .execute()

  return db
    .selectFrom('schedules')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

/** Minimal mock bot with a spied sendMessage. */
function makeMockBot() {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 999 })
  return {
    api: { sendMessage },
    // registerJob only uses bot.api.sendMessage
  } as any
}

describe('scheduler', () => {
  beforeEach(async () => {
    db = await setupDb()
  })

  afterEach(async () => {
    stopScheduler()
    await db.destroy()
  })

  // ── registerJob: past-due one-shot ─────────────────────────────

  it('fires immediately for past-due one-shot schedule', async () => {
    const bot = makeMockBot()
    const schedule = await insertSchedule(db, {
      run_at: '2020-01-01T00:00:00Z',
      message: 'overdue reminder',
      chat_id: '12345',
    })

    registerJob(db, bot, schedule, 'UTC')

    // Past-due path is fire-and-forget (.then()), wait for microtask flush
    await new Promise((r) => setTimeout(r, 50))

    expect(bot.api.sendMessage).toHaveBeenCalledWith('12345', 'overdue reminder')

    // Schedule should be cancelled after firing
    const schedules = await listSchedules(db, true)
    const found = schedules.find((s) => s.id === schedule.id)
    expect(found).toBeUndefined() // cancelled = active=0, so filtered out
  })

  it('marks last_run_at after firing past-due schedule', async () => {
    const bot = makeMockBot()
    const schedule = await insertSchedule(db, {
      run_at: '2020-01-01T00:00:00Z',
      message: 'check last_run',
      chat_id: '12345',
    })

    registerJob(db, bot, schedule, 'UTC')
    await new Promise((r) => setTimeout(r, 50))

    const row = await db
      .selectFrom('schedules')
      .select('last_run_at')
      .where('id', '=', schedule.id)
      .executeTakeFirstOrThrow()

    expect(row.last_run_at).toBeTruthy()
  })

  // ── registerJob: future one-shot ───────────────────────────────

  it('does NOT fire for future one-shot schedule', async () => {
    const bot = makeMockBot()
    const schedule = await insertSchedule(db, {
      run_at: '2099-12-31T23:59:59Z',
      message: 'future reminder',
      chat_id: '12345',
    })

    registerJob(db, bot, schedule, 'UTC')
    await new Promise((r) => setTimeout(r, 50))

    expect(bot.api.sendMessage).not.toHaveBeenCalled()

    // Schedule should still be active
    const schedules = await listSchedules(db, true)
    expect(schedules.find((s) => s.id === schedule.id)).toBeDefined()
  })

  // ── registerJob: cron ──────────────────────────────────────────

  it('registers cron job without immediate fire', async () => {
    const bot = makeMockBot()
    const schedule = await insertSchedule(db, {
      cron_expression: '0 0 * * *', // daily at midnight
      message: 'daily check',
      chat_id: '12345',
    })

    registerJob(db, bot, schedule, 'UTC')
    await new Promise((r) => setTimeout(r, 50))

    // Cron shouldn't fire immediately
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })

  // ── registerJob: deduplication ─────────────────────────────────

  it('ignores duplicate registerJob calls', async () => {
    const bot = makeMockBot()
    const schedule = await insertSchedule(db, {
      run_at: '2099-12-31T23:59:59Z',
      message: 'dedup test',
      chat_id: '12345',
    })

    registerJob(db, bot, schedule, 'UTC')
    registerJob(db, bot, schedule, 'UTC')
    registerJob(db, bot, schedule, 'UTC')

    // No error, no duplicate side effects
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })

  // ── stopScheduler cleanup ──────────────────────────────────────

  it('cleans up all jobs on stopScheduler', async () => {
    const bot = makeMockBot()

    const s1 = await insertSchedule(db, {
      cron_expression: '0 * * * *',
      message: 'hourly',
      chat_id: '12345',
    })
    const s2 = await insertSchedule(db, {
      run_at: '2099-06-01T00:00:00Z',
      message: 'future',
      chat_id: '12345',
    })

    registerJob(db, bot, schedule(s1), 'UTC')
    registerJob(db, bot, schedule(s2), 'UTC')

    // stopScheduler called in afterEach — verify it doesn't throw
    stopScheduler()

    // After stop, registering the same ID should work again (map was cleared)
    registerJob(db, bot, schedule(s1), 'UTC')
  })

  // ── DB query helpers ───────────────────────────────────────────

  it('listSchedules returns only active schedules', async () => {
    await insertSchedule(db, { message: 'active', chat_id: '1', run_at: '2099-01-01T00:00:00Z' })
    const s2 = await insertSchedule(db, { message: 'cancelled', chat_id: '1', run_at: '2099-01-01T00:00:00Z' })

    await cancelSchedule(db, s2.id)

    const active = await listSchedules(db, true)
    expect(active).toHaveLength(1)
    expect(active[0].message).toBe('active')

    const all = await listSchedules(db, false)
    expect(all).toHaveLength(2)
  })

  it('cancelSchedule is idempotent', async () => {
    const s = await insertSchedule(db, { message: 'x', chat_id: '1', run_at: '2099-01-01T00:00:00Z' })

    const first = await cancelSchedule(db, s.id)
    expect(first).toBe(true)

    const second = await cancelSchedule(db, s.id)
    expect(second).toBe(false)
  })

  it('markScheduleRun sets last_run_at', async () => {
    const s = await insertSchedule(db, { message: 'x', chat_id: '1', run_at: '2099-01-01T00:00:00Z' })
    expect(s.last_run_at).toBeNull()

    await markScheduleRun(db, s.id)

    const updated = await db
      .selectFrom('schedules')
      .select('last_run_at')
      .where('id', '=', s.id)
      .executeTakeFirstOrThrow()

    expect(updated.last_run_at).toBeTruthy()
  })
})

/** Identity helper — makes the test read better. */
function schedule(s: Schedule): Schedule {
  return s
}
