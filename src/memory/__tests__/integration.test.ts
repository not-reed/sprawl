/**
 * Integration tests for the memory system.
 * Uses google/gemini-2.5-flash-lite via OpenRouter for cheap real LLM calls.
 * Skips gracefully when OPENROUTER_API_KEY is not set.
 *
 * Run: OPENROUTER_API_KEY=<key> npx vitest run src/memory/__tests__/integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Kysely } from 'kysely'
import { createDb } from '../../db/index.js'
import type { Database } from '../../db/schema.js'
import * as migration001 from '../../db/migrations/001-initial.js'
import * as migration002 from '../../db/migrations/002-fts5-and-embeddings.js'
import * as migration004 from '../../db/migrations/004-telegram-message-ids.js'
import * as migration005 from '../../db/migrations/005-graph-memory.js'
import * as migration006 from '../../db/migrations/006-observational-memory.js'
import { extractEntities } from '../graph/extract.js'
import { processMemoryForGraph } from '../graph/index.js'
import { findNodeByName } from '../graph/queries.js'
import { observe } from '../observer.js'
import { reflect } from '../reflector.js'
import { MemoryManager, OBSERVER_MAX_BATCH_TOKENS } from '../index.js'
import { storeMemory, saveMessage, getOrCreateConversation } from '../../db/queries.js'
import type { WorkerModelConfig } from '../types.js'
import { estimateMessageTokens } from '../tokens.js'

// Read directly — can't import src/env.ts (requires TELEGRAM_BOT_TOKEN at parse time)
const API_KEY = process.env.OPENROUTER_API_KEY ?? ''

const WORKER_CONFIG: WorkerModelConfig = {
  apiKey: API_KEY,
  model: 'google/gemini-2.5-flash-lite',
  baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
}

const shouldRun = API_KEY.length > 0
const describeIntegration = shouldRun ? describe : describe.skip

let db: Kysely<Database>

async function setupDb(): Promise<Kysely<Database>> {
  const result = createDb(':memory:')
  const d = result.db
  await migration001.up(d as Kysely<unknown>)
  await migration002.up(d as Kysely<unknown>)
  await migration004.up(d as Kysely<unknown>)
  await migration005.up(d as Kysely<unknown>)
  await migration006.up(d as Kysely<unknown>)
  return d
}

describeIntegration('memory integration (LLM)', () => {
  beforeEach(async () => {
    db = await setupDb()
  })

  afterEach(async () => {
    await db.destroy()
  })

  // ── extractEntities ──────────────────────────────────────────────

  describe('extractEntities', () => {
    it('extracts entities from factual text', async () => {
      const result = await extractEntities(
        WORKER_CONFIG,
        'Alice works at Google in Mountain View. She is friends with Bob, who lives in San Francisco.',
      )

      expect(result.entities.length).toBeGreaterThan(0)
      expect(result.relationships.length).toBeGreaterThan(0)

      const names = result.entities.map((e) => e.name.toLowerCase())
      expect(names).toEqual(expect.arrayContaining([expect.stringContaining('alice')]))

      const types = new Set(result.entities.map((e) => e.type))
      expect(types.size).toBeGreaterThan(0)
      for (const t of types) {
        expect(['person', 'place', 'concept', 'event', 'entity']).toContain(t)
      }

      if (result.usage) {
        expect(result.usage.input_tokens).toBeGreaterThan(0)
        expect(result.usage.output_tokens).toBeGreaterThan(0)
      }
    }, 30_000)

    it('returns empty for mundane text', async () => {
      const result = await extractEntities(
        WORKER_CONFIG,
        'ok sounds good, thanks!',
      )

      // Should return empty or minimal — no throw
      expect(result.entities.length + result.relationships.length).toBeLessThanOrEqual(2)
    }, 30_000)
  })

  // ── processMemoryForGraph ────────────────────────────────────────

  describe('processMemoryForGraph', () => {
    it('creates nodes and edges end-to-end', async () => {
      const mem = await storeMemory(db, { content: 'Alice works at Google in Mountain View', source: 'user' })

      const result = await processMemoryForGraph(
        db,
        WORKER_CONFIG,
        mem.id,
        mem.content,
        // skip embeddings in test — no embedding model needed
      )

      expect(result.entities.length).toBeGreaterThan(0)

      // Nodes should be findable in the DB
      const alice = await findNodeByName(db, 'alice')
      expect(alice).toBeDefined()
      expect(alice!.node_type).toBe('person')

      // At least one edge should exist
      const edges = await db
        .selectFrom('graph_edges')
        .selectAll()
        .where('memory_id', '=', mem.id)
        .execute()
      expect(edges.length).toBeGreaterThan(0)
    }, 30_000)

    it('handles text with no entities', async () => {
      const mem = await storeMemory(db, { content: 'haha lol ok sure thing', source: 'user' })

      const result = await processMemoryForGraph(
        db,
        WORKER_CONFIG,
        mem.id,
        mem.content,
      )

      expect(result.entities).toHaveLength(0)

      // No nodes should have been created
      const nodes = await db.selectFrom('graph_nodes').selectAll().execute()
      expect(nodes).toHaveLength(0)
    }, 30_000)
  })

  // ── observe ──────────────────────────────────────────────────────

  describe('observe', () => {
    it('compresses conversation into observations', async () => {
      const result = await observe(WORKER_CONFIG, {
        messages: [
          { role: 'user', content: 'I have a dentist appointment on March 5th at 9am', created_at: '2024-01-15T10:00:00Z' },
          { role: 'assistant', content: 'Got it! I\'ll remember your dentist appointment on March 5th at 9am.', created_at: '2024-01-15T10:00:05Z' },
          { role: 'user', content: 'Also, I started learning Rust last week. Really enjoying it so far.', created_at: '2024-01-15T10:01:00Z' },
          { role: 'assistant', content: 'Nice! Rust is a great language. How are you finding the borrow checker?', created_at: '2024-01-15T10:01:05Z' },
          { role: 'user', content: 'It\'s tricky but I\'m getting used to it. My cat Max keeps sitting on my keyboard though.', created_at: '2024-01-15T10:02:00Z' },
        ],
      })

      expect(result.observations.length).toBeGreaterThan(0)

      for (const obs of result.observations) {
        expect(obs.content).toBeTruthy()
        expect(['low', 'medium', 'high']).toContain(obs.priority)
        expect(obs.observation_date).toBeTruthy()
      }
    }, 30_000)
  })

  // ── reflect ──────────────────────────────────────────────────────

  describe('reflect', () => {
    it('condenses related observations', async () => {
      const observations = [
        {
          id: 'obs-1',
          conversation_id: 'conv-1',
          content: 'User has a dentist appointment on March 5th at 9am',
          priority: 'high' as const,
          observation_date: '2024-01-15',
          source_message_ids: [],
          token_count: 15,
          generation: 0,
          superseded_at: null,
          created_at: '2024-01-15T10:00:00Z',
        },
        {
          id: 'obs-2',
          conversation_id: 'conv-1',
          content: 'User started learning Rust last week',
          priority: 'medium' as const,
          observation_date: '2024-01-15',
          source_message_ids: [],
          token_count: 10,
          generation: 0,
          superseded_at: null,
          created_at: '2024-01-15T10:01:00Z',
        },
        {
          id: 'obs-3',
          conversation_id: 'conv-1',
          content: 'User is enjoying learning Rust, finding borrow checker tricky',
          priority: 'medium' as const,
          observation_date: '2024-01-15',
          source_message_ids: [],
          token_count: 15,
          generation: 0,
          superseded_at: null,
          created_at: '2024-01-15T10:02:00Z',
        },
        {
          id: 'obs-4',
          conversation_id: 'conv-1',
          content: 'User has a cat named Max',
          priority: 'low' as const,
          observation_date: '2024-01-15',
          source_message_ids: [],
          token_count: 8,
          generation: 0,
          superseded_at: null,
          created_at: '2024-01-15T10:02:30Z',
        },
      ]

      const result = await reflect(WORKER_CONFIG, { observations })

      // Should produce fewer or same number of observations
      expect(result.observations.length).toBeLessThanOrEqual(observations.length)
      expect(result.observations.length).toBeGreaterThan(0)

      // superseded_ids should reference valid input IDs
      const inputIds = new Set(observations.map((o) => o.id))
      for (const id of result.superseded_ids) {
        expect(inputIds.has(id)).toBe(true)
      }

      for (const obs of result.observations) {
        expect(obs.content).toBeTruthy()
        expect(['low', 'medium', 'high']).toContain(obs.priority)
      }
    }, 30_000)
  })

  // ── MemoryManager.runObserver ────────────────────────────────────

  describe('MemoryManager.runObserver', () => {
    it('end-to-end pipeline with DB', async () => {
      const mm = new MemoryManager(db, WORKER_CONFIG)
      const convId = await getOrCreateConversation(db, 'test', null)

      // OBSERVER_THRESHOLD is 3000 tokens (~12000 chars). Seed a realistic conversation
      // then pad with additional exchanges to exceed the threshold.
      const seed = [
        { role: 'user', content: 'I just moved to Portland, Oregon last month. I work as a backend engineer at a startup called DataPipe. We do real-time data pipeline orchestration using Kafka and Flink. I own the Flink jobs — tons of stateful processing, aggregating clickstream data in 5-minute windows.' },
        { role: 'assistant', content: 'Welcome to Portland! DataPipe sounds interesting — Kafka and Flink are a solid combo for stream processing. Clickstream aggregation in windowed Flink jobs is no joke. Are you working on the core pipeline infrastructure or more on the consumer side?' },
        { role: 'user', content: 'Core infra mostly. Also, my girlfriend Sarah is visiting next weekend so I need to plan some stuff — thinking Forest Park for hiking and Powell\'s Books since she loves bookstores. Oh and I need to pick up my prescription from Walgreens tomorrow before 6pm.' },
        { role: 'assistant', content: 'Got it — prescription from Walgreens before 6pm tomorrow. Forest Park and Powell\'s are great choices for Sarah\'s visit. Powell\'s is especially wonderful if she loves bookstores. Want me to look up any restaurant recommendations too?' },
        { role: 'user', content: 'Sure! I live near Hawthorne Boulevard so anything walkable from there. I\'ve been learning Rust on the side too — the borrow checker is tough but I\'m getting the hang of it. My cat Whiskers keeps sitting on my keyboard while I code though.' },
        { role: 'assistant', content: 'Hawthorne has tons of great food options within walking distance. And Rust is a great complement to TypeScript — the borrow checker really clicks after a while. Classic cat behavior from Whiskers! How old is he?' },
      ]

      // Pad with enough exchanges to exceed 3000 tokens. Each padded pair is ~500 chars = ~125 tokens.
      // 6 seed messages ≈ 500 tokens. Need ~2500 more = ~20 pairs.
      const padding = Array.from({ length: 25 }, (_, i) => [
        { role: 'user', content: `Topic ${i + 1}: I've been exploring various aspects of software engineering lately, including distributed systems design patterns, microservice architectures with service mesh configurations, container orchestration best practices, and infrastructure as code tooling. Each area has its own set of challenges and tradeoffs that I find fascinating to reason about in depth.` },
        { role: 'assistant', content: `That's a broad and interesting set of topics! Distributed systems especially have so many subtle tradeoffs — CAP theorem implications, consistency models, partition tolerance strategies, and the operational complexity of running service meshes at scale. Which area are you finding most relevant to your current work at DataPipe?` },
      ]).flat()

      for (const msg of [...seed, ...padding]) {
        await saveMessage(db, { conversation_id: convId, role: msg.role, content: msg.content })
      }

      // Sanity check: we actually exceed the threshold
      const preCheck = await mm.getUnobservedMessages(convId)
      const preTokens = estimateMessageTokens(preCheck)
      expect(preTokens).toBeGreaterThan(3000)

      const result = await mm.runObserver(convId)
      expect(result).toBe(true)

      // Observations should be stored
      const obs = await mm.getActiveObservations(convId)
      expect(obs.length).toBeGreaterThan(0)

      // Watermark should have advanced
      const conv = await db
        .selectFrom('conversations')
        .select(['observed_up_to_message_id', 'observation_token_count'])
        .where('id', '=', convId)
        .executeTakeFirst()

      expect(conv!.observed_up_to_message_id).toBeTruthy()
      expect(conv!.observation_token_count).toBeGreaterThan(0)

      // No unobserved messages should remain
      const remaining = await mm.getUnobservedMessages(convId)
      expect(remaining).toHaveLength(0)
    }, 60_000)

    it('batches large message sets', async () => {
      const mm = new MemoryManager(db, WORKER_CONFIG)
      const convId = await getOrCreateConversation(db, 'test', null)

      // Generate messages that exceed OBSERVER_MAX_BATCH_TOKENS (16000 tokens = ~64000 chars).
      // Each message: ~500 chars content + "[Message N] " prefix = ~128 tokens + 4 overhead = ~132 tokens.
      // Need 16000/132 ≈ 122 messages minimum. Use 140 for margin.
      const largeContent = 'The user discussed various topics including their work schedule, '
        + 'favorite programming languages (TypeScript, Rust, Go), upcoming travel plans to Japan '
        + 'in April, their cat named Whiskers who is 3 years old, their preference for dark mode '
        + 'in all editors, and their ongoing project to build a home automation system using '
        + 'Raspberry Pi and Zigbee sensors. They also mentioned their partner Alex who works in '
        + 'graphic design and their weekly board game night on Thursdays with friends.'

      // Insert enough messages to trigger batching
      const msgCount = 140
      for (let i = 0; i < msgCount; i++) {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        await saveMessage(db, {
          conversation_id: convId,
          role,
          content: `[Message ${i + 1}] ${largeContent}`,
        })
      }

      // Verify messages actually exceed the batch limit
      const unobserved = await mm.getUnobservedMessages(convId)
      const totalTokens = estimateMessageTokens(unobserved)
      expect(totalTokens).toBeGreaterThan(OBSERVER_MAX_BATCH_TOKENS)

      // Verify batching would produce multiple batches
      const batches = mm.batchMessages(unobserved, OBSERVER_MAX_BATCH_TOKENS)
      expect(batches.length).toBeGreaterThan(1)

      const result = await mm.runObserver(convId)
      expect(result).toBe(true)

      // Watermark should have advanced to the last message
      const conv = await db
        .selectFrom('conversations')
        .select('observed_up_to_message_id')
        .where('id', '=', convId)
        .executeTakeFirst()

      expect(conv!.observed_up_to_message_id).toBe(unobserved[unobserved.length - 1].id)

      // All messages should now be observed
      const remaining = await mm.getUnobservedMessages(convId)
      expect(remaining).toHaveLength(0)

      // Observations should have been created
      const obs = await mm.getActiveObservations(convId)
      expect(obs.length).toBeGreaterThan(0)
    }, 120_000)
  })
})
