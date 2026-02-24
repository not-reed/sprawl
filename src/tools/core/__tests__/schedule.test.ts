import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Kysely } from 'kysely'
import { createDb } from '../../../db/index.js'
import type { Database } from '../../../db/schema.js'
import {
  createScheduleCreateTool,
  createScheduleListTool,
  createScheduleCancelTool,
} from '../schedule.js'
import * as migrations from '../../../db/migrations/001-initial.js'

let db: Kysely<Database>
const TEST_CHAT_ID = '12345'

beforeEach(async () => {
  const result = createDb(':memory:')
  db = result.db
  await migrations.up(db as Kysely<unknown>)
})

afterEach(async () => {
  await db.destroy()
})

describe('schedule_create', () => {
  it('creates a one-shot reminder with auto-injected chat_id', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID)
    const result = await tool.execute('t1', {
      description: 'Dentist appointment',
      message: 'Time for your dentist appointment!',
      run_at: '2025-03-05T09:00:00Z',
    })

    expect(result.output).toContain('one-shot')
    expect(result.output).toContain('Dentist appointment')
    const schedule = (result.details as any).schedule
    expect(schedule.run_at).toBe('2025-03-05T09:00:00Z')
    expect(schedule.cron_expression).toBeNull()
    expect(schedule.chat_id).toBe(TEST_CHAT_ID)
  })

  it('creates a recurring reminder', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID)
    const result = await tool.execute('t1', {
      description: 'Weekly standup',
      message: 'Standup time!',
      cron_expression: '0 9 * * 1',
    })

    expect(result.output).toContain('recurring')
    const schedule = (result.details as any).schedule
    expect(schedule.cron_expression).toBe('0 9 * * 1')
  })

  it('requires either cron or run_at', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID)
    const result = await tool.execute('t1', {
      description: 'No time',
      message: 'When?',
    })

    expect(result.output).toContain('Please provide')
  })
})

describe('schedule_list', () => {
  it('lists active schedules', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID)
    await create.execute('t1', {
      description: 'Reminder 1',
      message: 'Hey',
      run_at: '2025-04-01T10:00:00Z',
    })
    await create.execute('t2', {
      description: 'Reminder 2',
      message: 'Ho',
      cron_expression: '0 8 * * *',
    })

    const list = createScheduleListTool(db)
    const result = await list.execute('l1', {})

    expect(result.output).toContain('2 schedules')
    expect((result.details as any).schedules).toHaveLength(2)
  })

  it('returns empty when no schedules', async () => {
    const list = createScheduleListTool(db)
    const result = await list.execute('l1', {})

    expect(result.output).toContain('No scheduled reminders')
  })
})

describe('schedule_cancel', () => {
  it('cancels an active schedule', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID)
    const createResult = await create.execute('t1', {
      description: 'Cancel me',
      message: 'Bye',
      run_at: '2025-04-01T10:00:00Z',
    })
    const scheduleId = (createResult.details as any).schedule.id

    const cancel = createScheduleCancelTool(db)
    const result = await cancel.execute('c1', { id: scheduleId })

    expect(result.output).toContain('Cancelled')

    // Should not appear in active list
    const list = createScheduleListTool(db)
    const listResult = await list.execute('l1', {})
    expect(listResult.output).toContain('No scheduled reminders')
  })
})
