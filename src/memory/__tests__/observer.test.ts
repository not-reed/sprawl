import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Kysely } from 'kysely'
import { createDb } from '../../db/index.js'
import type { Database } from '../../db/schema.js'
import * as migration001 from '../../db/migrations/001-initial.js'
import * as migration004 from '../../db/migrations/004-telegram-message-ids.js'
import * as migration006 from '../../db/migrations/006-observational-memory.js'
import { MemoryManager } from '../index.js'
import { saveMessage, getOrCreateConversation } from '../../db/queries.js'

let db: Kysely<Database>

beforeEach(async () => {
  const result = createDb(':memory:')
  db = result.db
  await migration001.up(db as Kysely<unknown>)
  await migration004.up(db as Kysely<unknown>)
  await migration006.up(db as Kysely<unknown>)
})

afterEach(async () => {
  await db.destroy()
})

describe('MemoryManager observations', () => {
  it('getActiveObservations returns empty for new conversation', async () => {
    const mm = new MemoryManager(db, null)
    const convId = await getOrCreateConversation(db, 'cli', null)

    const obs = await mm.getActiveObservations(convId)
    expect(obs).toHaveLength(0)
  })

  it('getUnobservedMessages returns all messages when no watermark', async () => {
    const mm = new MemoryManager(db, null)
    const convId = await getOrCreateConversation(db, 'cli', null)

    await saveMessage(db, { conversation_id: convId, role: 'user', content: 'hello' })
    await saveMessage(db, { conversation_id: convId, role: 'assistant', content: 'hi' })

    const msgs = await mm.getUnobservedMessages(convId)
    expect(msgs).toHaveLength(2)
  })

  it('getUnobservedMessages respects watermark', async () => {
    const mm = new MemoryManager(db, null)
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
    const mm = new MemoryManager(db, null)
    const convId = await getOrCreateConversation(db, 'cli', null)

    const result = await mm.runObserver(convId)
    expect(result).toBe(false)
  })

  it('runObserver skips when messages below threshold', async () => {
    // Use a fake config — it won't be reached since threshold won't be met
    const mm = new MemoryManager(db, { apiKey: 'fake', model: 'fake' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    await saveMessage(db, { conversation_id: convId, role: 'user', content: 'hello' })

    const result = await mm.runObserver(convId)
    expect(result).toBe(false)
  })

  it('buildContext returns empty observations and all messages for new conversation', async () => {
    const mm = new MemoryManager(db, null)
    const convId = await getOrCreateConversation(db, 'cli', null)

    await saveMessage(db, { conversation_id: convId, role: 'user', content: 'hello' })

    const ctx = await mm.buildContext(convId)
    expect(ctx.hasObservations).toBe(false)
    expect(ctx.observationsText).toBe('')
    expect(ctx.activeMessages).toHaveLength(1)
  })

  it('buildContext separates observations from active messages', async () => {
    const mm = new MemoryManager(db, null)
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
