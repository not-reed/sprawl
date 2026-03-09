import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Kysely } from 'kysely'
import { createDb } from '@repo/db'
import type { Database } from '../../../db/schema.js'
import {
  createScheduleCreateTool,
  createScheduleListTool,
  createScheduleCancelTool,
} from '../schedule.js'
import * as migrations from '../../../db/migrations/001-initial.js'
import * as m008 from '../../../db/migrations/008-schedule-prompts.js'

vi.mock('@repo/cairn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@repo/cairn')>()
  return {
    ...actual,
    generateEmbedding: vi.fn(),
  }
})

import { generateEmbedding } from '@repo/cairn'
const mockGenerateEmbedding = vi.mocked(generateEmbedding)

let db: Kysely<Database>
const TEST_CHAT_ID = '12345'
const TEST_TZ = 'UTC'
const TEST_API_KEY = 'test-key'

beforeEach(async () => {
  const result = createDb<Database>(':memory:')
  db = result.db
  await migrations.up(db as Kysely<unknown>)
  await m008.up(db as Kysely<unknown>)
  mockGenerateEmbedding.mockReset()
  // Default: embedding calls reject (fast-path tests don't need them)
  mockGenerateEmbedding.mockRejectedValue(new Error('no embedding in test'))
})

afterEach(async () => {
  await db.destroy()
})

describe('schedule_create', () => {
  it('creates a one-shot reminder with auto-injected chat_id', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'Dentist appointment',
      instruction: 'Remind the user about their dentist appointment',
      run_at: '2025-03-05T09:00:00',
    })

    expect(result.output).toContain('one-shot')
    expect(result.output).toContain('Dentist appointment')
    const schedule = (result.details as any).schedule
    expect(schedule.run_at).toBe('2025-03-05T09:00:00')
    expect(schedule.cron_expression).toBeNull()
    expect(schedule.prompt).toBe('Remind the user about their dentist appointment')
    expect(schedule.chat_id).toBe(TEST_CHAT_ID)
  })

  it('creates a recurring reminder', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'Weekly standup',
      instruction: 'Remind about standup',
      cron_expression: '0 9 * * 1',
    })

    expect(result.output).toContain('recurring')
    const schedule = (result.details as any).schedule
    expect(schedule.cron_expression).toBe('0 9 * * 1')
  })

  it('requires either cron or run_at', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'No time',
      instruction: 'When?',
    })

    expect(result.output).toContain('Please provide')
  })

  it('strips trailing Z from run_at', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'Z-stripped',
      instruction: 'Hello',
      run_at: '2025-03-05T09:00:00Z',
    })

    const schedule = (result.details as any).schedule
    expect(schedule.run_at).toBe('2025-03-05T09:00:00')
  })

  it('strips timezone offset from run_at', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'Offset-stripped',
      instruction: 'Hello',
      run_at: '2025-03-05T09:00:00-08:00',
    })

    const schedule = (result.details as any).schedule
    expect(schedule.run_at).toBe('2025-03-05T09:00:00')
  })

  it('deduplicates one-shot schedules with same run_at and instruction', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

    const first = await tool.execute('t1', {
      description: 'Dentist',
      instruction: 'Go to dentist',
      run_at: '2025-03-05T09:00:00',
    })
    expect(first.output).toContain('Created')

    const second = await tool.execute('t2', {
      description: 'Dentist again',
      instruction: 'Go to dentist',
      run_at: '2025-03-05T09:00:00',
    })
    expect(second.output).toContain('already exists')
    expect((second.details as any).deduplicated).toBe(true)
    expect((second.details as any).schedule.id).toBe((first.details as any).schedule.id)
  })

  it('deduplicates with fuzzy message matching (case, whitespace)', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

    await tool.execute('t1', {
      description: 'Course reminder',
      instruction: 'FrontEndMasters Course Reminder',
      run_at: '2025-03-05T09:00:00',
    })

    const second = await tool.execute('t2', {
      description: 'Course reminder',
      instruction: 'frontend masters  course reminder',
      run_at: '2025-03-05T09:00:00',
    })
    expect(second.output).toContain('already exists')
    expect((second.details as any).deduplicated).toBe(true)
  })

  it('deduplicates rephrased instructions via Levenshtein similarity', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

    await tool.execute('t1', {
      description: 'Dentist',
      instruction: 'Time for your dentist appointment!',
      run_at: '2025-03-05T09:00:00',
    })

    const second = await tool.execute('t2', {
      description: 'Dentist',
      instruction: "Don't forget your dentist appointment!",
      run_at: '2025-03-05T09:00:00',
    })
    expect(second.output).toContain('already exists')
    expect((second.details as any).deduplicated).toBe(true)
  })

  it('allows different instructions at the same time', async () => {
    // First call has no candidates (empty DB), no embedding calls.
    // Second call: 2 embeddings (new desc + 1 existing candidate) — orthogonal vectors.
    mockGenerateEmbedding
      .mockResolvedValueOnce([0, 1, 0])  // "Call mom" description (new)
      .mockResolvedValueOnce([1, 0, 0])  // "Do laundry" description (existing) — orthogonal
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

    const first = await tool.execute('t1', {
      description: 'Do laundry',
      instruction: 'Remind about laundry',
      run_at: '2025-03-05T09:00:00',
    })
    expect(first.output).toContain('Created')

    const second = await tool.execute('t2', {
      description: 'Call mom',
      instruction: 'Remind to call mom',
      run_at: '2025-03-05T09:00:00',
    })
    expect(second.output).toContain('Created')
  })

  it('deduplicates semantically similar descriptions via embeddings', async () => {
    // Simulate embeddings that are very similar (cosine > 0.7)
    mockGenerateEmbedding
      .mockResolvedValueOnce([0.9, 0.1, 0.4])   // "Pickup Milo..." (new)
      .mockResolvedValueOnce([0.85, 0.15, 0.45]) // "McBride trip..." (existing) — very similar
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

    const first = await tool.execute('t1', {
      description: 'McBride trip for Milo sleepover',
      instruction: 'Remind about McBride trip for Milo sleepover',
      run_at: '2026-03-01T10:30:00',
    })
    expect(first.output).toContain('Created')

    const second = await tool.execute('t2', {
      description: 'Pickup Milo from McBride sleepover',
      instruction: 'Remind to pickup Milo from McBride sleepover',
      run_at: '2026-03-01T10:30:00',
    })
    expect(second.output).toContain('already exists')
    expect((second.details as any).deduplicated).toBe(true)
    expect((second.details as any).schedule.id).toBe((first.details as any).schedule.id)
  })

  it('deduplicates recurring schedules with same cron and instruction', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

    const first = await tool.execute('t1', {
      description: 'Daily standup',
      instruction: 'Standup time!',
      cron_expression: '0 9 * * *',
    })
    expect(first.output).toContain('Created')

    const second = await tool.execute('t2', {
      description: 'Morning standup',
      instruction: 'standup time!',
      cron_expression: '0 9 * * *',
    })
    expect(second.output).toContain('already exists')
    expect((second.details as any).deduplicated).toBe(true)
  })

  it('does not dedup across different chat_ids', async () => {
    const tool1 = createScheduleCreateTool(db, 'chat-a', TEST_TZ, TEST_API_KEY)
    const tool2 = createScheduleCreateTool(db, 'chat-b', TEST_TZ, TEST_API_KEY)

    await tool1.execute('t1', {
      description: 'Reminder',
      instruction: 'Hey',
      run_at: '2025-03-05T09:00:00',
    })

    const result = await tool2.execute('t2', {
      description: 'Reminder',
      instruction: 'Hey',
      run_at: '2025-03-05T09:00:00',
    })
    expect(result.output).toContain('Created')
  })

  it('deduplicates against legacy schedules using prompt ?? message fallback', async () => {
    // Insert a legacy schedule with message only (no prompt)
    await db.insertInto('schedules' as any).values({
      id: 'legacy-1',
      description: 'Take out trash',
      message: 'Take out the trash',
      prompt: null,
      chat_id: TEST_CHAT_ID,
      cron_expression: null,
      run_at: '2025-03-05T09:00:00',
      active: 1,
    }).execute()

    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'Trash reminder',
      instruction: 'Take out the trash',
      run_at: '2025-03-05T09:00:00',
    })
    expect(result.output).toContain('already exists')
    expect((result.details as any).deduplicated).toBe(true)
  })
})

describe('schedule_list', () => {
  it('lists active schedules', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    await create.execute('t1', {
      description: 'Reminder 1',
      instruction: 'Hey',
      run_at: '2025-04-01T10:00:00',
    })
    await create.execute('t2', {
      description: 'Reminder 2',
      instruction: 'Ho',
      cron_expression: '0 8 * * *',
    })

    const list = createScheduleListTool(db, TEST_TZ)
    const result = await list.execute('l1', {})

    expect(result.output).toContain('2 schedules')
    expect((result.details as any).schedules).toHaveLength(2)
  })

  it('shows timezone label for one-shot schedules', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID, 'America/Vancouver', TEST_API_KEY)
    await create.execute('t1', {
      description: 'Reminder',
      instruction: 'Hey',
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

  it('shows [agent] badge for schedules with prompt', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    await create.execute('t1', {
      description: 'Weather check',
      instruction: 'Check weather',
      cron_expression: '0 7 * * *',
    })

    const list = createScheduleListTool(db, TEST_TZ)
    const result = await list.execute('l1', {})

    // All new schedules have prompt set, so they all show [agent]
    expect(result.output).toContain('[agent]')
  })
})

describe('schedule_cancel', () => {
  it('cancels an active schedule', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const createResult = await create.execute('t1', {
      description: 'Cancel me',
      instruction: 'Bye',
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
