import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { createDb } from '../../db/index.js'
import type { Database } from '../../db/schema.js'
import * as m001 from '../../db/migrations/001-initial.js'
import * as m002 from '../../db/migrations/002-fts5-and-embeddings.js'
import * as m004 from '../../db/migrations/004-telegram-message-ids.js'
import * as m005 from '../../db/migrations/005-graph-memory.js'
import * as m006 from '../../db/migrations/006-observational-memory.js'
import * as m007 from '../../db/migrations/007-observation-promoted-at.js'
import { MemoryManager } from '../index.js'
import { getOrCreateConversation, storeMemory } from '../../db/queries.js'

// Mock embeddings module — each unique text gets an orthogonal unit vector
vi.mock('../../embeddings.js', () => {
  const embeddingMap = new Map<string, number[]>()
  let nextDim = 0
  const DIM = 16

  function getEmbedding(text: string): number[] {
    const cached = embeddingMap.get(text)
    if (cached) return cached
    // Assign next orthogonal dimension
    const v = new Array(DIM).fill(0)
    v[nextDim % DIM] = 1
    nextDim++
    embeddingMap.set(text, v)
    return v
  }

  return {
    generateEmbedding: vi.fn((_apiKey: string, text: string) =>
      Promise.resolve(getEmbedding(text)),
    ),
    cosineSimilarity: vi.fn((a: number[], b: number[]): number => {
      if (a.length !== b.length) return 0
      let dot = 0, na = 0, nb = 0
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
      }
      const d = Math.sqrt(na) * Math.sqrt(nb)
      return d === 0 ? 0 : dot / d
    }),
    _embeddingMap: embeddingMap,
    _reset: () => { embeddingMap.clear(); nextDim = 0 },
  }
})

let db: Kysely<Database>

beforeEach(async () => {
  const result = createDb(':memory:')
  db = result.db
  await m001.up(db as Kysely<unknown>)
  await m002.up(db as Kysely<unknown>)
  await m004.up(db as Kysely<unknown>)
  await m005.up(db as Kysely<unknown>)
  await m006.up(db as Kysely<unknown>)
  await m007.up(db as Kysely<unknown>)
})

afterEach(async () => {
  await db.destroy()
  vi.clearAllMocks()
  // Reset the embedding dimension counter between tests
  const { _reset } = await import('../../embeddings.js') as any
  _reset()
})

async function insertObservation(
  conversationId: string,
  content: string,
  priority: 'low' | 'medium' | 'high',
) {
  const id = nanoid()
  await db
    .insertInto('observations')
    .values({
      id,
      conversation_id: conversationId,
      content,
      priority,
      observation_date: '2024-01-15',
      source_message_ids: null,
      token_count: Math.ceil(content.length / 4),
      generation: 0,
    })
    .execute()
  return id
}

describe('promoteObservations', () => {
  it('promotes novel medium/high observations to memories', async () => {
    const mm = new MemoryManager(db, { apiKey: 'test', model: 'test-model' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    await insertObservation(convId, 'User has a dentist appointment on March 5th', 'high')
    await insertObservation(convId, 'User prefers dark mode in all editors', 'medium')

    const promoted = await mm.promoteObservations(convId)
    expect(promoted).toBe(2)

    // Verify memories were created
    const memories = await db
      .selectFrom('memories')
      .selectAll()
      .where('source', '=', 'observer')
      .execute()
    expect(memories).toHaveLength(2)
    expect(memories[0].category).toBe('observation')
    expect(memories[0].embedding).not.toBeNull()
  })

  it('skips low-priority observations', async () => {
    const mm = new MemoryManager(db, { apiKey: 'test', model: 'test-model' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    await insertObservation(convId, 'User said hello', 'low')
    await insertObservation(convId, 'Important fact about user', 'high')

    const promoted = await mm.promoteObservations(convId)
    expect(promoted).toBe(1)

    const memories = await db
      .selectFrom('memories')
      .selectAll()
      .where('source', '=', 'observer')
      .execute()
    expect(memories).toHaveLength(1)
    expect(memories[0].content).toBe('Important fact about user')
  })

  it('skips near-duplicate observations (sim >= 0.85)', async () => {
    const mm = new MemoryManager(db, { apiKey: 'test', model: 'test-model' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    // Pre-store a memory with the same content → embedding will match exactly
    const content = 'User is allergic to shellfish'
    const { generateEmbedding } = await import('../../embeddings.js')
    const embedding = await generateEmbedding('test', content)
    await storeMemory(db, {
      content,
      category: 'health',
      source: 'user',
      embedding: JSON.stringify(embedding),
      tags: null,
    })

    // Insert observation with identical text → should be skipped
    await insertObservation(convId, content, 'high')

    const promoted = await mm.promoteObservations(convId)
    expect(promoted).toBe(0)
  })

  it('marks all candidates promoted_at regardless of outcome', async () => {
    const mm = new MemoryManager(db, { apiKey: 'test', model: 'test-model' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    // One novel, one that will be a near-duplicate
    const dupContent = 'Existing memory content'
    const { generateEmbedding } = await import('../../embeddings.js')
    const embedding = await generateEmbedding('test', dupContent)
    await storeMemory(db, {
      content: dupContent,
      category: 'general',
      source: 'user',
      embedding: JSON.stringify(embedding),
      tags: null,
    })

    const id1 = await insertObservation(convId, dupContent, 'medium') // dup
    const id2 = await insertObservation(convId, 'Completely novel observation content here xyz', 'high') // novel

    await mm.promoteObservations(convId)

    // Both should have promoted_at set
    const obs = await db
      .selectFrom('observations')
      .select(['id', 'promoted_at'])
      .where('id', 'in', [id1, id2])
      .execute()

    for (const o of obs) {
      expect(o.promoted_at).not.toBeNull()
    }
  })

  it('does nothing without worker config', async () => {
    const mm = new MemoryManager(db, null)
    const convId = await getOrCreateConversation(db, 'cli', null)

    await insertObservation(convId, 'Some observation', 'high')

    const promoted = await mm.promoteObservations(convId)
    expect(promoted).toBe(0)
  })

  it('does not re-promote already-promoted observations', async () => {
    const mm = new MemoryManager(db, { apiKey: 'test', model: 'test-model' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    await insertObservation(convId, 'First run observation', 'high')

    const first = await mm.promoteObservations(convId)
    expect(first).toBe(1)

    // Second run: no new candidates
    const second = await mm.promoteObservations(convId)
    expect(second).toBe(0)
  })

  it('deduplicates within the same batch', async () => {
    const mm = new MemoryManager(db, { apiKey: 'test', model: 'test-model' })
    const convId = await getOrCreateConversation(db, 'cli', null)

    // Two observations with identical content → second should be deduped
    const content = 'User bought a new laptop today'
    await insertObservation(convId, content, 'medium')
    await insertObservation(convId, content, 'high')

    const promoted = await mm.promoteObservations(convId)
    // First promotes, second is a duplicate of the first
    expect(promoted).toBe(1)

    const memories = await db
      .selectFrom('memories')
      .selectAll()
      .where('source', '=', 'observer')
      .execute()
    expect(memories).toHaveLength(1)
  })
})
