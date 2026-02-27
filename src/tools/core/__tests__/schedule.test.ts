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
const TEST_TZ = 'UTC'

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
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)
    const result = await tool.execute('t1', {
      description: 'Dentist appointment',
      message: 'Time for your dentist appointment!',
      run_at: '2025-03-05T09:00:00',
    })

    expect(result.output).toContain('one-shot')
    expect(result.output).toContain('Dentist appointment')
    const schedule = (result.details as any).schedule
    expect(schedule.run_at).toBe('2025-03-05T09:00:00')
    expect(schedule.cron_expression).toBeNull()
    expect(schedule.chat_id).toBe(TEST_CHAT_ID)
  })

  it('creates a recurring reminder', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)
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
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)
    const result = await tool.execute('t1', {
      description: 'No time',
      message: 'When?',
    })

    expect(result.output).toContain('Please provide')
  })

  it('strips trailing Z from run_at', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)
    const result = await tool.execute('t1', {
      description: 'Z-stripped',
      message: 'Hello',
      run_at: '2025-03-05T09:00:00Z',
    })

    const schedule = (result.details as any).schedule
    expect(schedule.run_at).toBe('2025-03-05T09:00:00')
  })

  it('strips timezone offset from run_at', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)
    const result = await tool.execute('t1', {
      description: 'Offset-stripped',
      message: 'Hello',
      run_at: '2025-03-05T09:00:00-08:00',
    })

    const schedule = (result.details as any).schedule
    expect(schedule.run_at).toBe('2025-03-05T09:00:00')
  })

  it('deduplicates one-shot schedules with same run_at and message', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)

    const first = await tool.execute('t1', {
      description: 'Dentist',
      message: 'Go to dentist',
      run_at: '2025-03-05T09:00:00',
    })
    expect(first.output).toContain('Created')

    const second = await tool.execute('t2', {
      description: 'Dentist again',
      message: 'Go to dentist',
      run_at: '2025-03-05T09:00:00',
    })
    expect(second.output).toContain('already exists')
    expect((second.details as any).deduplicated).toBe(true)
    expect((second.details as any).schedule.id).toBe((first.details as any).schedule.id)
  })

  it('deduplicates with fuzzy message matching (case, whitespace)', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)

    await tool.execute('t1', {
      description: 'Course reminder',
      message: 'FrontEndMasters Course Reminder',
      run_at: '2025-03-05T09:00:00',
    })

    const second = await tool.execute('t2', {
      description: 'Course reminder',
      message: 'frontend masters  course reminder',
      run_at: '2025-03-05T09:00:00',
    })
    expect(second.output).toContain('already exists')
    expect((second.details as any).deduplicated).toBe(true)
  })

  it('deduplicates rephrased messages via Levenshtein similarity', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)

    await tool.execute('t1', {
      description: 'Dentist',
      message: 'Time for your dentist appointment!',
      run_at: '2025-03-05T09:00:00',
    })

    const second = await tool.execute('t2', {
      description: 'Dentist',
      message: "Don't forget your dentist appointment!",
      run_at: '2025-03-05T09:00:00',
    })
    expect(second.output).toContain('already exists')
    expect((second.details as any).deduplicated).toBe(true)
  })

  it('allows different messages at the same time', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)

    const first = await tool.execute('t1', {
      description: 'Reminder A',
      message: 'Do laundry',
      run_at: '2025-03-05T09:00:00',
    })
    expect(first.output).toContain('Created')

    const second = await tool.execute('t2', {
      description: 'Reminder B',
      message: 'Call mom',
      run_at: '2025-03-05T09:00:00',
    })
    expect(second.output).toContain('Created')
  })

  it('deduplicates recurring schedules with same cron and message', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)

    const first = await tool.execute('t1', {
      description: 'Daily standup',
      message: 'Standup time!',
      cron_expression: '0 9 * * *',
    })
    expect(first.output).toContain('Created')

    const second = await tool.execute('t2', {
      description: 'Morning standup',
      message: 'standup time!',
      cron_expression: '0 9 * * *',
    })
    expect(second.output).toContain('already exists')
    expect((second.details as any).deduplicated).toBe(true)
  })

  it('does not dedup across different chat_ids', async () => {
    const tool1 = createScheduleCreateTool(db, 'chat-a', TEST_TZ)
    const tool2 = createScheduleCreateTool(db, 'chat-b', TEST_TZ)

    await tool1.execute('t1', {
      description: 'Reminder',
      message: 'Hey',
      run_at: '2025-03-05T09:00:00',
    })

    const result = await tool2.execute('t2', {
      description: 'Reminder',
      message: 'Hey',
      run_at: '2025-03-05T09:00:00',
    })
    expect(result.output).toContain('Created')
  })
})

describe('schedule_list', () => {
  it('lists active schedules', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)
    await create.execute('t1', {
      description: 'Reminder 1',
      message: 'Hey',
      run_at: '2025-04-01T10:00:00',
    })
    await create.execute('t2', {
      description: 'Reminder 2',
      message: 'Ho',
      cron_expression: '0 8 * * *',
    })

    const list = createScheduleListTool(db, TEST_TZ)
    const result = await list.execute('l1', {})

    expect(result.output).toContain('2 schedules')
    expect((result.details as any).schedules).toHaveLength(2)
  })

  it('shows timezone label for one-shot schedules', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID, 'America/Vancouver')
    await create.execute('t1', {
      description: 'Reminder',
      message: 'Hey',
      run_at: '2025-04-01T10:00:00',
    })

    const list = createScheduleListTool(db, 'America/Vancouver')
    const result = await list.execute('l1', {})

    expect(result.output).toContain('(America/Vancouver)')
  })

  it('returns empty when no schedules', async () => {
    const list = createScheduleListTool(db, TEST_TZ)
    const result = await list.execute('l1', {})

    expect(result.output).toContain('No scheduled reminders')
  })
})

describe('schedule_cancel', () => {
  it('cancels an active schedule', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ)
    const createResult = await create.execute('t1', {
      description: 'Cancel me',
      message: 'Bye',
      run_at: '2025-04-01T10:00:00',
    })
    const scheduleId = (createResult.details as any).schedule.id

    const cancel = createScheduleCancelTool(db)
    const result = await cancel.execute('c1', { id: scheduleId })

    expect(result.output).toContain('Cancelled')

    // Should not appear in active list
    const list = createScheduleListTool(db, TEST_TZ)
    const listResult = await list.execute('l1', {})
    expect(listResult.output).toContain('No scheduled reminders')
  })
})
