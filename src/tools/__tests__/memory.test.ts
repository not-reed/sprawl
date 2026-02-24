import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Kysely } from 'kysely'
import { createDb } from '../../db/index.js'
import type { Database } from '../../db/schema.js'
import { createMemoryStoreTool } from '../memory-store.js'
import { createMemoryRecallTool } from '../memory-recall.js'
import { createMemoryForgetTool } from '../memory-forget.js'
import * as migration001 from '../../db/migrations/001-initial.js'
import * as migration002 from '../../db/migrations/002-fts5-and-embeddings.js'

let db: Kysely<Database>

beforeEach(async () => {
  const result = createDb(':memory:')
  db = result.db
  await migration001.up(db as Kysely<unknown>)
  await migration002.up(db as Kysely<unknown>)
})

afterEach(async () => {
  await db.destroy()
})

describe('memory_store', () => {
  it('stores a memory and returns it', async () => {
    const tool = createMemoryStoreTool(db)
    const result = await tool.execute('test-1', {
      content: 'My dentist appointment is March 5th',
      category: 'reminder',
      tags: ['dentist', 'appointment', 'march'],
    })

    expect(result.output).toContain('dentist appointment')
    expect(result.output).toContain('reminder')
    expect(result.details).toBeDefined()

    const memory = (result.details as any).memory
    expect(memory.content).toBe('My dentist appointment is March 5th')
    expect(memory.category).toBe('reminder')
    expect(JSON.parse(memory.tags)).toEqual(['dentist', 'appointment', 'march'])
  })

  it('defaults category to general', async () => {
    const tool = createMemoryStoreTool(db)
    const result = await tool.execute('test-2', {
      content: 'The sky is blue',
    })

    const memory = (result.details as any).memory
    expect(memory.category).toBe('general')
  })
})

describe('memory_recall', () => {
  it('finds memories by keyword', async () => {
    const store = createMemoryStoreTool(db)
    await store.execute('s1', { content: 'My favorite color is blue', tags: ['color', 'blue'] })
    await store.execute('s2', { content: 'I like pizza', tags: ['food', 'pizza'] })
    await store.execute('s3', { content: 'The sky is blue today', tags: ['weather', 'blue'] })

    const recall = createMemoryRecallTool(db)
    const result = await recall.execute('r1', { query: 'blue' })

    expect(result.output).toContain('2 memories')
    const memories = (result.details as any).memories
    expect(memories).toHaveLength(2)
  })

  it('filters by category', async () => {
    const store = createMemoryStoreTool(db)
    await store.execute('s1', { content: 'I like red', category: 'preference' })
    await store.execute('s2', { content: 'Red is a color', category: 'fact' })

    const recall = createMemoryRecallTool(db)
    const result = await recall.execute('r1', { query: 'red', category: 'preference' })

    const memories = (result.details as any).memories
    expect(memories).toHaveLength(1)
    expect(memories[0].category).toBe('preference')
  })

  it('returns empty for no match', async () => {
    const recall = createMemoryRecallTool(db)
    const result = await recall.execute('r1', { query: 'nonexistent' })

    expect(result.output).toContain('No memories found')
    expect((result.details as any).memories).toHaveLength(0)
  })
})

describe('memory_forget', () => {
  it('archives a memory by id', async () => {
    const store = createMemoryStoreTool(db)
    const storeResult = await store.execute('s1', { content: 'Delete me' })
    const memoryId = (storeResult.details as any).memory.id

    const forget = createMemoryForgetTool(db)
    const result = await forget.execute('f1', { id: memoryId })

    expect(result.output).toContain('Archived')

    // Should not appear in recall
    const recall = createMemoryRecallTool(db)
    const recallResult = await recall.execute('r1', { query: 'Delete' })
    expect((recallResult.details as any).memories).toHaveLength(0)
  })

  it('searches for candidates when given a query', async () => {
    const store = createMemoryStoreTool(db)
    await store.execute('s1', { content: 'Remember to forget this' })

    const forget = createMemoryForgetTool(db)
    const result = await forget.execute('f1', { query: 'forget' })

    expect(result.output).toContain('1 memories matching')
    expect((result.details as any).candidates).toHaveLength(1)
  })

  it('requires id or query', async () => {
    const forget = createMemoryForgetTool(db)
    const result = await forget.execute('f1', {})

    expect(result.output).toContain('Please provide')
  })
})
