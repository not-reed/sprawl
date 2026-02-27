/**
 * Pipeline tests for buildContextPreamble() — the function that assembles
 * the dynamic context prepended to user messages.
 *
 * Pure function tests (no DB) plus one end-to-end scenario with seeded data.
 * No API key needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { buildContextPreamble } from '../system-prompt.js'
import { recallMemories, getOrCreateConversation } from '../db/queries.js'
import {
  setupDb,
  seedAll,
  queryEmbeddings,
  observationFixtures,
  identity,
} from './fixtures.js'
import { renderObservations } from '../memory/context.js'
import type { Observation } from '../memory/types.js'

describe('buildContextPreamble — full preamble', () => {
  it('includes all sections when all inputs provided', () => {
    const preamble = buildContextPreamble({
      timezone: 'America/Los_Angeles',
      source: 'telegram',
      observations: '! [2024-01-15] Dentist on March 5th\n- [2024-01-15] Learning Rust',
      recentMemories: [
        { content: 'Alex has a cat named Miso', category: 'personal', created_at: '2024-01-15T10:00:00Z' },
      ],
      relevantMemories: [
        { content: 'Alex is allergic to shellfish', category: 'health', score: 0.95 },
        { content: 'Alex works at DataPipe', category: 'work', score: 0.82 },
      ],
      skills: [
        { name: 'Daily Standup', description: 'Run standup', requires: {}, body: 'Ask about blockers and progress.', filePath: '' },
      ],
      replyContext: 'What should I have for dinner?',
    })

    // Context line
    expect(preamble).toContain('America/Los_Angeles')
    expect(preamble).toContain('telegram')

    // Observations section
    expect(preamble).toContain('[Conversation observations')
    expect(preamble).toContain('Dentist on March 5th')

    // Recent memories section
    expect(preamble).toContain('[Recent memories')
    expect(preamble).toContain('(personal) Alex has a cat named Miso')

    // Relevant memories with scores
    expect(preamble).toContain('[Potentially relevant memories]')
    expect(preamble).toContain('(health) Alex is allergic to shellfish (95% match)')
    expect(preamble).toContain('(work) Alex works at DataPipe (82% match)')

    // Skills section
    expect(preamble).toContain('[Active skills')
    expect(preamble).toContain('### Daily Standup')
    expect(preamble).toContain('Ask about blockers')

    // Reply context
    expect(preamble).toContain('[Replying to: "What should I have for dinner?"]')
  })
})

describe('buildContextPreamble — observations only', () => {
  it('includes observations but omits memory/skill sections', () => {
    const preamble = buildContextPreamble({
      timezone: 'UTC',
      source: 'cli',
      observations: '! [2024-01-15] Important observation',
    })

    expect(preamble).toContain('[Conversation observations')
    expect(preamble).toContain('Important observation')
    expect(preamble).not.toContain('[Recent memories')
    expect(preamble).not.toContain('[Potentially relevant memories]')
    expect(preamble).not.toContain('[Active skills')
    expect(preamble).not.toContain('[Replying to')
  })
})

describe('buildContextPreamble — relevant memories with scores', () => {
  it('formats scores as percentages', () => {
    const preamble = buildContextPreamble({
      timezone: 'UTC',
      source: 'test',
      relevantMemories: [
        { content: 'Memory A', category: 'work', score: 0.456 },
        { content: 'Memory B', category: 'personal', score: 1.0 },
        { content: 'Memory C', category: 'health' }, // no score
      ],
    })

    expect(preamble).toContain('(work) Memory A (46% match)')
    expect(preamble).toContain('(personal) Memory B (100% match)')
    expect(preamble).toContain('(health) Memory C')
    expect(preamble).not.toMatch(/Memory C.*%/)
  })
})

describe('buildContextPreamble — empty inputs', () => {
  it('produces minimal preamble with only context line', () => {
    const preamble = buildContextPreamble({
      timezone: 'UTC',
      source: 'test',
    })

    // Should have the context line
    expect(preamble).toMatch(/\[Context:.*UTC.*test\]/)

    // Should NOT have any optional sections
    expect(preamble).not.toContain('[Conversation observations')
    expect(preamble).not.toContain('[Recent memories')
    expect(preamble).not.toContain('[Potentially relevant memories]')
    expect(preamble).not.toContain('[Active skills')
    expect(preamble).not.toContain('[Replying to')
  })

  it('omits sections for empty arrays', () => {
    const preamble = buildContextPreamble({
      timezone: 'UTC',
      source: 'test',
      recentMemories: [],
      relevantMemories: [],
      skills: [],
    })

    expect(preamble).not.toContain('[Recent memories')
    expect(preamble).not.toContain('[Potentially relevant memories]')
    expect(preamble).not.toContain('[Active skills')
  })
})

describe('buildContextPreamble — reply context', () => {
  it('includes reply context string', () => {
    const preamble = buildContextPreamble({
      timezone: 'UTC',
      source: 'test',
      replyContext: 'Can you remind me about my appointment?',
    })

    expect(preamble).toContain('[Replying to: "Can you remind me about my appointment?"]')
  })

  it('truncates long reply context to 300 chars', () => {
    const longReply = 'x'.repeat(500)
    const preamble = buildContextPreamble({
      timezone: 'UTC',
      source: 'test',
      replyContext: longReply,
    })

    // The truncated content should be exactly 300 chars
    expect(preamble).toContain('[Replying to: "' + 'x'.repeat(300) + '"]')
    expect(preamble).not.toContain('x'.repeat(301))
  })
})

describe('buildContextPreamble — dev mode', () => {
  it('includes dev mode indicator', () => {
    const preamble = buildContextPreamble({
      timezone: 'UTC',
      source: 'cli',
      dev: true,
    })

    expect(preamble).toContain('DEV MODE')
    expect(preamble).toContain('self_deploy is disabled')
  })
})

describe('buildContextPreamble — end-to-end composition', () => {
  let db: Kysely<Database>

  beforeEach(async () => {
    db = await setupDb()
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('seeded data flows through recall into preamble', async () => {
    const convId = await getOrCreateConversation(db, 'test', null)
    const { memoryIds } = await seedAll(db, convId)

    // Recall work-related memories using embedding search
    const recalled = await recallMemories(db, 'engineering data', {
      queryEmbedding: queryEmbeddings.work,
      limit: 5,
    })

    // Build preamble with recalled memories + observations
    const observations = observationFixtures
      .map((o) => ({
        id: 'obs-test',
        conversation_id: convId,
        content: o.content,
        priority: o.priority,
        observation_date: o.observation_date,
        source_message_ids: [],
        token_count: 0,
        generation: 0,
        superseded_at: null,
        created_at: '2024-01-15T00:00:00Z',
      })) satisfies Observation[]

    const preamble = buildContextPreamble({
      timezone: 'America/Los_Angeles',
      source: 'telegram',
      observations: renderObservations(observations),
      relevantMemories: recalled.map((m) => ({
        content: m.content,
        category: m.category,
        score: m.score,
      })),
    })

    // Preamble should contain recalled work memories
    expect(preamble).toContain('DataPipe')

    // Preamble should contain observations
    expect(preamble).toContain('dentist appointment')
    expect(preamble).toContain('learning Rust')

    // Preamble should have standard structure
    expect(preamble).toContain('[Conversation observations')
    expect(preamble).toContain('[Potentially relevant memories]')
  })
})
