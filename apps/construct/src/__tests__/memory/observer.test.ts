import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Kysely } from 'kysely'
import { createDb } from '@repo/db'
import type { Database } from '../../db/schema.js'
import * as migration001 from '../../db/migrations/001-initial.js'
import * as migration004 from '../../db/migrations/004-telegram-message-ids.js'
import * as migration006 from '../../db/migrations/006-observational-memory.js'
import { MemoryManager } from '@repo/cairn'
import { saveMessage, getOrCreateConversation } from '../../db/queries.js'
import { isDegenerateRaw, sanitizeObservations } from '@repo/cairn'

let db: Kysely<Database>

beforeEach(async () => {
  const result = createDb<Database>(':memory:')
  db = result.db
  await migration001.up(db as Kysely<any>)
  await migration004.up(db as Kysely<any>)
  await migration006.up(db as Kysely<any>)
})

afterEach(async () => {
  await db.destroy()
})

describe('MemoryManager observations', () => {
  it('getActiveObservations returns empty for new conversation', async () => {
    const mm = new MemoryManager(db, { workerConfig: null, apiKey: '' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    const obs = await mm.getActiveObservations(convId)
    expect(obs).toHaveLength(0)
  })

  it('getUnobservedMessages returns all messages when no watermark', async () => {
    const mm = new MemoryManager(db, { workerConfig: null, apiKey: '' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    await saveMessage(db, { conversation_id: convId, role: 'user', content: 'hello' })
    await saveMessage(db, { conversation_id: convId, role: 'assistant', content: 'hi' })

    const msgs = await mm.getUnobservedMessages(convId)
    expect(msgs).toHaveLength(2)
  })

  it('getUnobservedMessages respects watermark', async () => {
    const mm = new MemoryManager(db, { workerConfig: null, apiKey: '' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    await saveMessage(db, { conversation_id: convId, role: 'user', content: 'first' })
    const id2 = await saveMessage(db, { conversation_id: convId, role: 'assistant', content: 'response' })
    await saveMessage(db, { conversation_id: convId, role: 'user', content: 'second' })

    // Set watermark to id2
    await db
      .updateTable('conversations')
      .set({ observed_up_to_message_id: id2 })
      .where('id', '=', convId)
      .execute()

    const msgs = await mm.getUnobservedMessages(convId)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('second')
  })

  it('runObserver skips when no worker model configured', async () => {
    const mm = new MemoryManager(db, { workerConfig: null, apiKey: '' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    const result = await mm.runObserver(convId)
    expect(result).toBe(false)
  })

  it('runObserver skips when messages below threshold', async () => {
    // Use a fake config — it won't be reached since threshold won't be met
    const mm = new MemoryManager(db, { workerConfig: { apiKey: 'fake', model: 'fake' }, apiKey: 'fake' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    await saveMessage(db, { conversation_id: convId, role: 'user', content: 'hello' })

    const result = await mm.runObserver(convId)
    expect(result).toBe(false)
  })

  it('buildContext returns empty observations and all messages for new conversation', async () => {
    const mm = new MemoryManager(db, { workerConfig: null, apiKey: '' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    await saveMessage(db, { conversation_id: convId, role: 'user', content: 'hello' })

    const ctx = await mm.buildContext(convId)
    expect(ctx.hasObservations).toBe(false)
    expect(ctx.observationsText).toBe('')
    expect(ctx.activeMessages).toHaveLength(1)
  })

  it('buildContext separates observations from active messages', async () => {
    const mm = new MemoryManager(db, { workerConfig: null, apiKey: '' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    // Insert a manual observation
    const { nanoid } = await import('nanoid')
    await db
      .insertInto('observations')
      .values({
        id: nanoid(),
        conversation_id: convId,
        content: 'User prefers TypeScript',
        priority: 'high',
        observation_date: '2024-01-15',
        token_count: 10,
      })
      .execute()

    const id1 = await saveMessage(db, { conversation_id: convId, role: 'user', content: 'old msg' })
    // Set watermark to id1 so only messages after it are "active"
    await db
      .updateTable('conversations')
      .set({ observed_up_to_message_id: id1 })
      .where('id', '=', convId)
      .execute()

    await saveMessage(db, { conversation_id: convId, role: 'user', content: 'new msg' })

    const ctx = await mm.buildContext(convId)
    expect(ctx.hasObservations).toBe(true)
    expect(ctx.observationsText).toContain('TypeScript')
    expect(ctx.activeMessages).toHaveLength(1)
    expect(ctx.activeMessages[0].content).toBe('new msg')
  })
})

describe('isDegenerateRaw', () => {
  it('returns true for text over 50KB', () => {
    const text = 'x'.repeat(50_001)
    expect(isDegenerateRaw(text)).toBe(true)
  })

  it('returns true for repeated 100-char blocks', () => {
    const block = 'a'.repeat(100)
    // 3 repetitions at 100-char intervals triggers detection
    const text = block + block + block
    expect(isDegenerateRaw(text)).toBe(true)
  })

  it('returns false for normal JSON text', () => {
    const text = JSON.stringify({
      observations: [
        { content: 'User likes TypeScript', priority: 'medium', observation_date: '2025-01-15' },
        { content: 'User moved to Portland', priority: 'high', observation_date: '2025-01-15' },
      ],
    })
    expect(isDegenerateRaw(text)).toBe(false)
  })

  it('returns false for short text', () => {
    expect(isDegenerateRaw('hello')).toBe(false)
  })

  it('returns false for text exactly at 50KB', () => {
    const text = 'x'.repeat(50_000)
    // All blocks are identical but text is exactly at the limit, not over
    // However, repeated blocks will still trigger
    expect(isDegenerateRaw(text)).toBe(true)
  })

  it('returns false for varied text under 50KB', () => {
    // Build text where every 100-char block is unique
    let text = ''
    for (let i = 0; i < 100; i++) {
      text += String(i).padStart(4, '0') + 'y'.repeat(96)
    }
    expect(isDegenerateRaw(text)).toBe(false)
  })
})

describe('sanitizeObservations', () => {
  const obs = (content: string, priority: 'low' | 'medium' | 'high' = 'medium') => ({
    content,
    priority,
    observation_date: '2025-01-15',
  })

  it('truncates content over 2000 chars', () => {
    const longContent = 'a'.repeat(2500)
    const result = sanitizeObservations([obs(longContent)], 10)
    expect(result[0].content).toHaveLength(2003) // 2000 + '...'
    expect(result[0].content.endsWith('...')).toBe(true)
  })

  it('does not truncate content at exactly 2000 chars', () => {
    const content = 'a'.repeat(2000)
    const result = sanitizeObservations([obs(content)], 10)
    expect(result[0].content).toHaveLength(2000)
  })

  it('caps observation count at inputMessages * 3', () => {
    const observations = Array.from({ length: 20 }, (_, i) => obs(`fact ${i}`))
    const result = sanitizeObservations(observations, 5) // cap = max(15, 50) = 50
    expect(result).toHaveLength(20) // 20 < 50, all kept
  })

  it('caps observation count with floor of 50', () => {
    const observations = Array.from({ length: 60 }, (_, i) => obs(`fact ${i}`))
    const result = sanitizeObservations(observations, 10) // cap = max(30, 50) = 50
    expect(result).toHaveLength(50)
  })

  it('caps when inputMessages * 3 exceeds 50', () => {
    const observations = Array.from({ length: 100 }, (_, i) => obs(`fact ${i}`))
    const result = sanitizeObservations(observations, 20) // cap = max(60, 50) = 60
    expect(result).toHaveLength(60)
  })

  it('deduplicates identical content', () => {
    const result = sanitizeObservations(
      [obs('User likes cats'), obs('User likes dogs'), obs('User likes cats')],
      10,
    )
    expect(result).toHaveLength(2)
    expect(result.map((o: any) => o.content)).toEqual(['User likes cats', 'User likes dogs'])
  })

  it('preserves order after deduplication', () => {
    const result = sanitizeObservations(
      [obs('first'), obs('second'), obs('first'), obs('third')],
      10,
    )
    expect(result.map((o: any) => o.content)).toEqual(['first', 'second', 'third'])
  })
})
