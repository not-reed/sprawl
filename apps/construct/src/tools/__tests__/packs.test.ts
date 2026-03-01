import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Kysely } from 'kysely'
import { createDb } from '@repo/db'
import type { Database } from '../../db/schema.js'
import { selectPacks, selectAndCreateTools, type ToolPack, type ToolContext } from '../packs.js'
import * as migration001 from '../../db/migrations/001-initial.js'
import * as migration002 from '../../db/migrations/002-fts5-and-embeddings.js'

// Synthetic packs for testing (factories are empty — we only test selection logic)
const corePack: ToolPack = {
  name: 'core',
  description: 'Long-term memory storage and recall',
  alwaysLoad: true,
  factories: [],
}

const webPack: ToolPack = {
  name: 'web',
  description: 'Search the web, read web pages',
  alwaysLoad: false,
  factories: [],
}

const selfPack: ToolPack = {
  name: 'self',
  description: 'Read, edit, test, and deploy own source code',
  alwaysLoad: false,
  factories: [],
}

const allPacks = [corePack, webPack, selfPack]

// Synthetic embedding vectors (3-dimensional for simplicity)
// Web-like direction: [1, 0, 0]
// Self-like direction: [0, 1, 0]
// Core-like direction: [0, 0, 1]
const packEmbeddings = new Map<string, number[]>([
  ['web', [1, 0, 0]],
  ['self', [0, 1, 0]],
])

describe('selectPacks', () => {
  it('always includes alwaysLoad packs', () => {
    // Query embedding points toward web
    const queryEmbedding = [1, 0, 0]
    const selected = selectPacks(queryEmbedding, allPacks, packEmbeddings, 0.3)

    const names = selected.map((p) => p.name)
    expect(names).toContain('core')
  })

  it('loads all packs when queryEmbedding is undefined', () => {
    const selected = selectPacks(undefined, allPacks, packEmbeddings, 0.3)

    expect(selected).toHaveLength(3)
    const names = selected.map((p) => p.name)
    expect(names).toContain('core')
    expect(names).toContain('web')
    expect(names).toContain('self')
  })

  it('selects high-similarity packs and excludes low-similarity', () => {
    // Query points strongly toward web, orthogonal to self
    const queryEmbedding = [1, 0, 0]
    const selected = selectPacks(queryEmbedding, allPacks, packEmbeddings, 0.3)

    const names = selected.map((p) => p.name)
    expect(names).toContain('core') // always loaded
    expect(names).toContain('web')  // high similarity (1.0)
    expect(names).not.toContain('self') // zero similarity
  })

  it('selects pack when similarity equals threshold', () => {
    // Embed at 45 degrees between web and self: cos(45°) ≈ 0.707
    const queryEmbedding = [1, 1, 0]
    const selected = selectPacks(queryEmbedding, allPacks, packEmbeddings, 0.7)

    const names = selected.map((p) => p.name)
    // Both web and self should be selected (cos similarity ≈ 0.707 ≥ 0.7)
    expect(names).toContain('web')
    expect(names).toContain('self')
  })

  it('falls back to loading pack when its embedding is missing', () => {
    const sparseEmbeddings = new Map<string, number[]>([
      // web has an embedding, self does not
      ['web', [1, 0, 0]],
    ])

    // Query points away from web
    const queryEmbedding = [0, 0, 1]
    const selected = selectPacks(queryEmbedding, allPacks, sparseEmbeddings, 0.3)

    const names = selected.map((p) => p.name)
    expect(names).toContain('core')  // always loaded
    expect(names).toContain('self')  // no embedding → fallback to loading
    expect(names).not.toContain('web') // has embedding, low similarity
  })

  it('excludes all non-alwaysLoad packs when similarity is low', () => {
    // Query is orthogonal to both web and self embeddings
    const queryEmbedding = [0, 0, 1]
    const selected = selectPacks(queryEmbedding, allPacks, packEmbeddings, 0.3)

    const names = selected.map((p) => p.name)
    expect(names).toEqual(['core']) // only alwaysLoad
  })

  it('works with empty packs array', () => {
    const selected = selectPacks([1, 0, 0], [], packEmbeddings, 0.3)
    expect(selected).toHaveLength(0)
  })
})

// ---------- selectAndCreateTools ----------

describe('selectAndCreateTools', () => {
  let db: Kysely<Database>

  beforeEach(async () => {
    const result = createDb<Database>(':memory:')
    db = result.db
    await migration001.up(db as Kysely<unknown>)
    await migration002.up(db as Kysely<unknown>)
  })

  afterEach(async () => {
    await db.destroy()
  })

  function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
    return {
      db,
      chatId: 'test-chat',
      apiKey: 'test-key',
      projectRoot: '/tmp/test-project',
      dbPath: ':memory:',
      timezone: 'UTC',
      tavilyApiKey: 'tavily-key',
      isDev: false,
      ...overrides,
    }
  }

  it('returns tools from all packs when queryEmbedding is undefined', () => {
    const ctx = makeCtx()
    const tools = selectAndCreateTools(undefined, ctx)

    const names = tools.map((t) => t.name)
    // Core tools always included
    expect(names).toContain('memory_store')
    expect(names).toContain('memory_recall')
    expect(names).toContain('schedule_create')
    // Web tools included (tavily key present)
    expect(names).toContain('web_read')
    expect(names).toContain('web_search')
    // Self tools included
    expect(names).toContain('self_read_source')
    expect(names).toContain('self_edit_source')
    expect(names).toContain('self_run_tests')
    expect(names).toContain('self_deploy')
  })

  it('filters out null factories (no tavilyApiKey → no web_search)', () => {
    const ctx = makeCtx({ tavilyApiKey: undefined })
    const tools = selectAndCreateTools(undefined, ctx)

    const names = tools.map((t) => t.name)
    expect(names).toContain('web_read')
    expect(names).not.toContain('web_search')
  })

  it('excludes self_deploy when isDev is true', () => {
    const ctx = makeCtx({ isDev: true })
    const tools = selectAndCreateTools(undefined, ctx)

    const names = tools.map((t) => t.name)
    expect(names).not.toContain('self_deploy')
    // Other self tools should still be present
    expect(names).toContain('self_read_source')
    expect(names).toContain('self_run_tests')
  })
})
