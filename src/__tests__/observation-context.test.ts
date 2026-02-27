/**
 * Pipeline tests for MemoryManager.buildContext() — observations + unobserved
 * messages split, watermark accuracy, priority rendering.
 *
 * No API key needed. MemoryManager is instantiated with null workerConfig.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { getOrCreateConversation, saveMessage } from '../db/queries.js'
import { MemoryManager } from '../memory/index.js'
import { renderObservations } from '../memory/context.js'
import { setupDb, seedObservations, observationFixtures } from './fixtures.js'
import type { Observation } from '../memory/types.js'

let db: Kysely<Database>
let mm: MemoryManager
let convId: string

beforeEach(async () => {
  db = await setupDb()
  mm = new MemoryManager(db, null)
  convId = await getOrCreateConversation(db, 'test', null)
})

afterEach(async () => {
  await db.destroy()
})

describe('MemoryManager.buildContext — observations replace old messages', () => {
  it('returns observations text + only unobserved messages', async () => {
    // Insert 15 messages
    const msgIds: string[] = []
    for (let i = 1; i <= 15; i++) {
      const id = await saveMessage(db, {
        conversation_id: convId,
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `Message ${i}`,
      })
      msgIds.push(id)
    }

    // Seed observations
    await seedObservations(db, convId)

    // Set watermark to message 10 (messages 1-10 are "observed")
    await db
      .updateTable('conversations')
      .set({ observed_up_to_message_id: msgIds[9] }) // 0-indexed, msg 10
      .where('id', '=', convId)
      .execute()

    const ctx = await mm.buildContext(convId)

    // Should have observations
    expect(ctx.hasObservations).toBe(true)
    expect(ctx.observationsText).toBeTruthy()

    // Active messages should be only 11-15 (after watermark)
    expect(ctx.activeMessages).toHaveLength(5)
    expect(ctx.activeMessages[0].content).toBe('Message 11')
    expect(ctx.activeMessages[4].content).toBe('Message 15')
  })
})

describe('MemoryManager.buildContext — no observations fallback', () => {
  it('returns empty observations + all messages when no observations exist', async () => {
    // Insert some messages, no observations
    for (let i = 1; i <= 5; i++) {
      await saveMessage(db, {
        conversation_id: convId,
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `Message ${i}`,
      })
    }

    const ctx = await mm.buildContext(convId)

    expect(ctx.hasObservations).toBe(false)
    expect(ctx.observationsText).toBe('')
    expect(ctx.activeMessages).toHaveLength(5)
    expect(ctx.activeMessages[0].content).toBe('Message 1')
  })
})

describe('renderObservations — priority markers', () => {
  it('renders high/medium/low with correct markers', () => {
    const observations: Observation[] = [
      {
        id: 'obs-1',
        conversation_id: convId,
        content: 'High priority item',
        priority: 'high',
        observation_date: '2024-01-15',
        source_message_ids: [],
        token_count: 10,
        generation: 0,
        superseded_at: null,
        created_at: '2024-01-15T10:00:00Z',
      },
      {
        id: 'obs-2',
        conversation_id: convId,
        content: 'Medium priority item',
        priority: 'medium',
        observation_date: '2024-01-15',
        source_message_ids: [],
        token_count: 10,
        generation: 0,
        superseded_at: null,
        created_at: '2024-01-15T10:01:00Z',
      },
      {
        id: 'obs-3',
        conversation_id: convId,
        content: 'Low priority item',
        priority: 'low',
        observation_date: '2024-01-15',
        source_message_ids: [],
        token_count: 10,
        generation: 0,
        superseded_at: null,
        created_at: '2024-01-15T10:02:00Z',
      },
    ]

    const rendered = renderObservations(observations)

    expect(rendered).toContain('! [2024-01-15] High priority item')
    expect(rendered).toContain('- [2024-01-15] Medium priority item')
    expect(rendered).toContain('~ [2024-01-15] Low priority item')
  })

  it('renders observations in input order', () => {
    const observations: Observation[] = observationFixtures.map((o, i) => ({
      id: `obs-${i}`,
      conversation_id: convId,
      content: o.content,
      priority: o.priority,
      observation_date: o.observation_date,
      source_message_ids: [],
      token_count: 10,
      generation: 0,
      superseded_at: null,
      created_at: `2024-01-15T10:0${i}:00Z`,
    }))

    const rendered = renderObservations(observations)
    const lines = rendered.split('\n')

    // First observation (high priority dentist)
    expect(lines[0]).toMatch(/^! \[2024-01-15\] User has a dentist/)

    // Order should match input array order
    expect(lines.length).toBe(observationFixtures.length)
  })

  it('returns empty string for no observations', () => {
    expect(renderObservations([])).toBe('')
  })
})

describe('MemoryManager.buildContext — watermark accuracy', () => {
  it('watermark at message 10 returns only messages 11+', async () => {
    const msgIds: string[] = []
    for (let i = 1; i <= 20; i++) {
      const id = await saveMessage(db, {
        conversation_id: convId,
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `Message ${i}`,
      })
      msgIds.push(id)
    }

    // Set watermark to message 10
    await db
      .updateTable('conversations')
      .set({ observed_up_to_message_id: msgIds[9] })
      .where('id', '=', convId)
      .execute()

    const unobserved = await mm.getUnobservedMessages(convId)

    expect(unobserved).toHaveLength(10)
    expect(unobserved[0].content).toBe('Message 11')
    expect(unobserved[9].content).toBe('Message 20')
  })

  it('no watermark returns all messages', async () => {
    for (let i = 1; i <= 5; i++) {
      await saveMessage(db, {
        conversation_id: convId,
        role: 'user',
        content: `Message ${i}`,
      })
    }

    const unobserved = await mm.getUnobservedMessages(convId)
    expect(unobserved).toHaveLength(5)
    expect(unobserved[0].content).toBe('Message 1')
  })

  it('watermark at last message returns no unobserved', async () => {
    const msgIds: string[] = []
    for (let i = 1; i <= 5; i++) {
      const id = await saveMessage(db, {
        conversation_id: convId,
        role: 'user',
        content: `Message ${i}`,
      })
      msgIds.push(id)
    }

    // Set watermark to the last message
    await db
      .updateTable('conversations')
      .set({ observed_up_to_message_id: msgIds[4] })
      .where('id', '=', convId)
      .execute()

    const unobserved = await mm.getUnobservedMessages(convId)
    expect(unobserved).toHaveLength(0)
  })
})

describe('MemoryManager.buildContext — full integration', () => {
  it('observations text matches DB state + messages split correctly', async () => {
    // Insert messages and set watermark
    const msgIds: string[] = []
    for (let i = 1; i <= 10; i++) {
      const id = await saveMessage(db, {
        conversation_id: convId,
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `Msg ${i}`,
      })
      msgIds.push(id)
    }

    // Seed observations and set watermark at message 7
    await seedObservations(db, convId)
    await db
      .updateTable('conversations')
      .set({ observed_up_to_message_id: msgIds[6] })
      .where('id', '=', convId)
      .execute()

    const ctx = await mm.buildContext(convId)

    // Observations rendered
    expect(ctx.hasObservations).toBe(true)
    expect(ctx.observationsText).toContain('dentist appointment')
    expect(ctx.observationsText).toContain('learning Rust')
    expect(ctx.observationsText).toContain('DataPipe')
    expect(ctx.observationsText).toContain('Miso')
    expect(ctx.observationsText).toContain('Sarah')

    // Active messages are 8-10
    expect(ctx.activeMessages).toHaveLength(3)
    expect(ctx.activeMessages[0].content).toBe('Msg 8')
    expect(ctx.activeMessages[2].content).toBe('Msg 10')
  })
})
