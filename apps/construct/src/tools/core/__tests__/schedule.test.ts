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
      message: 'Time for your dentist appointment!',
      run_at: '2025-03-05T09:00:00',
    })

    expect(result.output).toContain('one-shot')
    expect(result.output).toContain('static-message')
    expect(result.output).toContain('Dentist appointment')
    const schedule = (result.details as any).schedule
    expect(schedule.run_at).toBe('2025-03-05T09:00:00')
    expect(schedule.cron_expression).toBeNull()
    expect(schedule.prompt).toBeNull()
    expect(schedule.chat_id).toBe(TEST_CHAT_ID)
  })

  it('creates a recurring reminder', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
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
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'No time',
      message: 'When?',
    })

    expect(result.output).toContain('Please provide')
  })

  it('strips trailing Z from run_at', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'Z-stripped',
      message: 'Hello',
      run_at: '2025-03-05T09:00:00Z',
    })

    const schedule = (result.details as any).schedule
    expect(schedule.run_at).toBe('2025-03-05T09:00:00')
  })

  it('strips timezone offset from run_at', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'Offset-stripped',
      message: 'Hello',
      run_at: '2025-03-05T09:00:00-08:00',
    })

    const schedule = (result.details as any).schedule
    expect(schedule.run_at).toBe('2025-03-05T09:00:00')
  })

  it('deduplicates one-shot schedules with same run_at and message', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

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
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

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
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

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
    // First call has no candidates (empty DB), no embedding calls.
    // Second call: 2 embeddings (new desc + 1 existing candidate) — orthogonal vectors.
    mockGenerateEmbedding
      .mockResolvedValueOnce([0, 1, 0])  // "Call mom" description (new)
      .mockResolvedValueOnce([1, 0, 0])  // "Do laundry" description (existing) — orthogonal
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

    const first = await tool.execute('t1', {
      description: 'Do laundry',
      message: 'Do laundry',
      run_at: '2025-03-05T09:00:00',
    })
    expect(first.output).toContain('Created')

    const second = await tool.execute('t2', {
      description: 'Call mom',
      message: 'Call mom',
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
      message: 'McBride trip for Milo sleepover',
      run_at: '2026-03-01T10:30:00',
    })
    expect(first.output).toContain('Created')

    const second = await tool.execute('t2', {
      description: 'Pickup Milo from McBride sleepover',
      message: 'Pickup Milo from McBride sleepover',
      run_at: '2026-03-01T10:30:00',
    })
    expect(second.output).toContain('already exists')
    expect((second.details as any).deduplicated).toBe(true)
    expect((second.details as any).schedule.id).toBe((first.details as any).schedule.id)
  })

  it('deduplicates recurring schedules with same cron and message', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

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
    const tool1 = createScheduleCreateTool(db, 'chat-a', TEST_TZ, TEST_API_KEY)
    const tool2 = createScheduleCreateTool(db, 'chat-b', TEST_TZ, TEST_API_KEY)

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

  // ── Prompt-based schedules ──────────────────────────────────────

  it('creates a prompt-based schedule', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'Weather check',
      prompt: 'Check the weather and alert if below freezing',
      cron_expression: '0 7 * * *',
    })

    expect(result.output).toContain('agent-prompt')
    expect(result.output).toContain('recurring')
    const schedule = (result.details as any).schedule
    expect(schedule.prompt).toBe('Check the weather and alert if below freezing')
    expect(schedule.message).toBe('Weather check') // defaults to description
  })

  it('rejects when both message and prompt provided', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'Conflict',
      message: 'static msg',
      prompt: 'agent prompt',
      run_at: '2025-03-05T09:00:00',
    })

    expect(result.output).toContain('not both')
  })

  it('rejects when neither message nor prompt provided', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    const result = await tool.execute('t1', {
      description: 'Empty',
      run_at: '2025-03-05T09:00:00',
    })

    expect(result.output).toContain('message')
    expect(result.output).toContain('prompt')
  })

  it('does not dedup across static and prompt modes', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

    const first = await tool.execute('t1', {
      description: 'Weather check',
      message: 'Check the weather',
      cron_expression: '0 7 * * *',
    })
    expect(first.output).toContain('Created')

    const second = await tool.execute('t2', {
      description: 'Weather check',
      prompt: 'Check the weather',
      cron_expression: '0 7 * * *',
    })
    expect(second.output).toContain('Created')
    // Both should exist as separate schedules
    expect((first.details as any).schedule.id).not.toBe((second.details as any).schedule.id)
  })

  it('deduplicates prompt-based schedules with same prompt and time', async () => {
    const tool = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)

    const first = await tool.execute('t1', {
      description: 'Weather check',
      prompt: 'Check the weather and alert if cold',
      cron_expression: '0 7 * * *',
    })
    expect(first.output).toContain('Created')

    const second = await tool.execute('t2', {
      description: 'Morning weather',
      prompt: 'Check the weather and alert if cold',
      cron_expression: '0 7 * * *',
    })
    expect(second.output).toContain('already exists')
    expect((second.details as any).deduplicated).toBe(true)
  })
})

describe('schedule_list', () => {
  it('lists active schedules', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
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
    const create = createScheduleCreateTool(db, TEST_CHAT_ID, 'America/Vancouver', TEST_API_KEY)
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

  it('shows [agent] badge for prompt-based schedules', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
    await create.execute('t1', {
      description: 'Weather check',
      prompt: 'Check weather',
      cron_expression: '0 7 * * *',
    })
    await create.execute('t2', {
      description: 'Plain reminder',
      message: 'Hey',
      run_at: '2025-04-01T10:00:00',
    })

    const list = createScheduleListTool(db, TEST_TZ)
    const result = await list.execute('l1', {})

    expect(result.output).toContain('[agent]')
    // Only the prompt-based one should have [agent]
    const lines = result.output.split('\n')
    const agentLine = lines.find((l: string) => l.includes('[agent]'))
    const plainLine = lines.find((l: string) => l.includes('Plain reminder'))
    expect(agentLine).toContain('Weather check')
    expect(plainLine).not.toContain('[agent]')
  })
})

describe('schedule_cancel', () => {
  it('cancels an active schedule', async () => {
    const create = createScheduleCreateTool(db, TEST_CHAT_ID, TEST_TZ, TEST_API_KEY)
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
