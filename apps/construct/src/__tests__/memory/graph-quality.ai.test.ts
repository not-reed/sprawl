/**
 * Graph quality tests — verifies that real LLM extraction produces
 * a useful, connected knowledge graph over multiple memories.
 *
 * ~8 LLM calls using gemini-2.5-flash-lite (pennies per run).
 * Run: OPENROUTER_API_KEY=<key> npm run test:ai
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { WorkerModelConfig } from '@repo/cairn'
import { setupDb } from '../../__tests__/fixtures.js'
import {
  storeMemory,
  processMemoryForGraph,
  findNodeByName,
  traverseGraph,
  getRelatedMemoryIds,
  getNodeEdges,
} from '@repo/cairn'

const API_KEY = process.env.OPENROUTER_API_KEY ?? ''

const WORKER_CONFIG: WorkerModelConfig = {
  apiKey: API_KEY,
  model: 'google/gemini-2.5-flash-lite',
  baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
}

const shouldRun = API_KEY.length > 0
const describeGraph = shouldRun ? describe : describe.skip

let db: Kysely<Database>

describeGraph('graph quality — real extraction', () => {
  beforeEach(async () => {
    db = await setupDb()
  })

  afterEach(async () => {
    await db.destroy()
  })

  // ── Accumulation: 5 memories → connected graph ──────────────────

  it('builds a connected hub-and-spoke graph from related memories', async () => {
    const inputs = [
      'Alex works at DataPipe as a senior backend engineer',
      'Alex has a cat named Miso who is 3 years old',
      'Alex is allergic to shellfish, carries an EpiPen',
      'Alex lives in Portland, Oregon',
      'Alex is learning Rust programming',
    ]

    const memoryIds: string[] = []
    for (const content of inputs) {
      const mem = await storeMemory(db, { content, source: 'user' })
      memoryIds.push(mem.id)
      await processMemoryForGraph(db, WORKER_CONFIG, mem.id, mem.content)
    }

    const allNodes = await db.selectFrom('graph_nodes').selectAll().execute()
    const allEdges = await db.selectFrom('graph_edges').selectAll().execute()

    // -- Reasonable node count (not too sparse, not explosive) --
    expect(allNodes.length).toBeGreaterThanOrEqual(4)
    expect(allNodes.length).toBeLessThanOrEqual(20)

    // -- Alex should exist as a person and act as hub --
    const alex = await findNodeByName(db, 'alex')
    expect(alex).toBeDefined()
    expect(alex!.node_type).toBe('person')

    const alexEdges = allEdges.filter(
      (e) => e.source_id === alex!.id || e.target_id === alex!.id,
    )
    // Alex should connect to at least 3 distinct entities
    expect(alexEdges.length).toBeGreaterThanOrEqual(3)

    // -- Every edge should carry a memory_id --
    for (const edge of allEdges) {
      expect(edge.memory_id).toBeTruthy()
    }

    // -- Traversal from Alex reaches the neighborhood --
    const traversed = await traverseGraph(db, alex!.id, 2)
    expect(traversed.length).toBeGreaterThanOrEqual(3)

    // -- Most memory IDs should be reachable via graph --
    const reachableNodeIds = [alex!.id, ...traversed.map((t) => t.node.id)]
    const relatedMemIds = await getRelatedMemoryIds(db, reachableNodeIds)
    // At least 3 of our 5 memories should be graph-linked
    expect(relatedMemIds.length).toBeGreaterThanOrEqual(3)

    const linkedSet = new Set(relatedMemIds)
    const linkedCount = memoryIds.filter((id) => linkedSet.has(id)).length
    expect(linkedCount).toBeGreaterThanOrEqual(3)
  }, 60_000)

  // ── Deduplication: same entity across memories → one node ──────

  it('deduplicates entities mentioned across multiple memories', async () => {
    const mem1 = await storeMemory(db, {
      content: 'Alex works at DataPipe',
      source: 'user',
    })
    await processMemoryForGraph(db, WORKER_CONFIG, mem1.id, mem1.content)

    const mem2 = await storeMemory(db, {
      content: 'Alex has a cat named Miso',
      source: 'user',
    })
    await processMemoryForGraph(db, WORKER_CONFIG, mem2.id, mem2.content)

    // Alex should be one node, not two
    const allNodes = await db.selectFrom('graph_nodes').selectAll().execute()
    const alexNodes = allNodes.filter((n) => n.name === 'alex')
    expect(alexNodes).toHaveLength(1)

    // But Alex should have edges from both memories
    const alexEdges = await getNodeEdges(db, alexNodes[0].id)
    const edgeMemoryIds = new Set(
      alexEdges.map((e) => e.memory_id).filter(Boolean),
    )
    expect(edgeMemoryIds.size).toBeGreaterThanOrEqual(2)
    expect(edgeMemoryIds.has(mem1.id)).toBe(true)
    expect(edgeMemoryIds.has(mem2.id)).toBe(true)
  }, 30_000)

  // ── Cross-topic discovery via hub ──────────────────────────────

  it('graph bridges unrelated topics through a shared entity', async () => {
    // Pet fact and health fact — completely different topics,
    // connected only through "Alex"
    const petMem = await storeMemory(db, {
      content: 'Alex has a cat named Miso',
      source: 'user',
    })
    await processMemoryForGraph(db, WORKER_CONFIG, petMem.id, petMem.content)

    const healthMem = await storeMemory(db, {
      content: 'Alex is severely allergic to shellfish',
      source: 'user',
    })
    await processMemoryForGraph(
      db,
      WORKER_CONFIG,
      healthMem.id,
      healthMem.content,
    )

    // Both memories should be reachable from the Alex hub
    const alex = await findNodeByName(db, 'alex')
    expect(alex).toBeDefined()

    const traversed = await traverseGraph(db, alex!.id, 1)
    const neighborhood = [alex!.id, ...traversed.map((t) => t.node.id)]
    const relatedMemIds = await getRelatedMemoryIds(db, neighborhood)

    // The key assertion: both the pet AND health memories are
    // discoverable from Alex's neighborhood
    expect(relatedMemIds).toContain(petMem.id)
    expect(relatedMemIds).toContain(healthMem.id)
  }, 30_000)

  // ── Dense extraction: one sentence, multiple entities ──────────

  it('extracts multiple entities from a single dense sentence', async () => {
    const mem = await storeMemory(db, {
      content:
        'Sarah and Alex went hiking at Forest Park in Portland last Saturday',
      source: 'user',
    })
    await processMemoryForGraph(db, WORKER_CONFIG, mem.id, mem.content)

    const allNodes = await db.selectFrom('graph_nodes').selectAll().execute()
    const allEdges = await db.selectFrom('graph_edges').selectAll().execute()

    // Should extract at least 3 entities (Alex, Sarah, Portland/Forest Park)
    expect(allNodes.length).toBeGreaterThanOrEqual(3)

    // Should create at least 2 relationships
    expect(allEdges.length).toBeGreaterThanOrEqual(2)

    // All edges linked to this memory
    for (const edge of allEdges) {
      expect(edge.memory_id).toBe(mem.id)
    }

    // Node names should be lowercase (normalization)
    for (const node of allNodes) {
      expect(node.name).toBe(node.name.toLowerCase())
    }
  }, 30_000)
})
