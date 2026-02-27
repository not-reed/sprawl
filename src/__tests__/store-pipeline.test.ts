/**
 * Pipeline tests for write operations and their downstream impact on retrieval.
 *
 * Verifies that data written via storeMemory, updateMemoryEmbedding,
 * upsertNode, upsertEdge is correctly queryable via FTS5, embedding
 * cosine search, and graph traversal.
 *
 * The retrieval tests (recall-pipeline, graph-recall) prove recall works
 * given correct data. These tests prove the write path *produces* correct data.
 *
 * No API key needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import {
  storeMemory,
  updateMemoryEmbedding,
  recallMemories,
  forgetMemory,
} from '../db/queries.js'
import {
  upsertNode,
  upsertEdge,
  findNodeByName,
  searchNodes,
  traverseGraph,
  getRelatedMemoryIds,
  getNodeEdges,
} from '../memory/graph/queries.js'
import { cosineSimilarity } from '../embeddings.js'
import { setupDb, memoryEmbeddings, queryEmbeddings } from './fixtures.js'

let db: Kysely<Database>

beforeEach(async () => {
  db = await setupDb()
})

afterEach(async () => {
  await db.destroy()
})

// ── Memory → FTS5 write consistency ─────────────────────────────────

describe('memory writes → FTS5 sync', () => {
  it('storeMemory makes content searchable via FTS5', async () => {
    await storeMemory(db, {
      content: 'Alex is allergic to shellfish',
      category: 'health',
      source: 'user',
    })

    const results = await recallMemories(db, 'shellfish')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].matchType).toBe('fts5')
    expect(results[0].content).toContain('shellfish')
  })

  it('storeMemory makes tags searchable via FTS5', async () => {
    await storeMemory(db, {
      content: 'Some memory about health',
      category: 'health',
      tags: 'epipen,medical,allergy',
      source: 'user',
    })

    // Search by tag keyword, not in content
    const results = await recallMemories(db, 'epipen')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].tags).toContain('epipen')
  })

  it('archived memory excluded from FTS5 recall', async () => {
    const mem = await storeMemory(db, {
      content: 'Alex has a unique pet iguana named Spike',
      category: 'personal',
      source: 'user',
    })

    // Findable before archiving
    let results = await recallMemories(db, 'iguana')
    expect(results.length).toBeGreaterThan(0)

    await forgetMemory(db, mem.id)

    // Not findable after archiving
    results = await recallMemories(db, 'iguana')
    expect(results).toHaveLength(0)
  })

  it('multiple memories with overlapping keywords all appear in FTS5', async () => {
    await storeMemory(db, { content: 'Alex likes Python for scripting', source: 'user' })
    await storeMemory(db, { content: 'Alex prefers Python over Ruby', source: 'user' })
    await storeMemory(db, { content: 'Alex uses Python at work daily', source: 'user' })

    const results = await recallMemories(db, 'Python')
    expect(results.length).toBe(3)
  })
})

// ── Memory → embedding write consistency ────────────────────────────

describe('memory writes → embedding recall', () => {
  it('memory without embedding is not found by embedding search', async () => {
    await storeMemory(db, {
      content: 'A memory with no embedding vector',
      category: 'general',
      source: 'user',
      // no embedding
    })

    const results = await recallMemories(db, 'xyzzy_no_keyword', {
      queryEmbedding: queryEmbeddings.pet,
    })

    // Should not find it — no embedding to compare against
    expect(results).toHaveLength(0)
  })

  it('updateMemoryEmbedding makes memory findable by embedding recall', async () => {
    const mem = await storeMemory(db, {
      content: 'A fact about pets stored without embedding',
      category: 'personal',
      source: 'user',
    })

    // Not findable before embedding
    let results = await recallMemories(db, 'xyzzy_no_keyword', {
      queryEmbedding: queryEmbeddings.pet,
    })
    expect(results.find((r) => r.id === mem.id)).toBeUndefined()

    // Add embedding in pet direction
    await updateMemoryEmbedding(db, mem.id, memoryEmbeddings.miso)

    // Now findable via embedding
    results = await recallMemories(db, 'xyzzy_no_keyword', {
      queryEmbedding: queryEmbeddings.pet,
    })
    const found = results.find((r) => r.id === mem.id)
    expect(found).toBeDefined()
    expect(found!.matchType).toBe('embedding')
    expect(found!.score).toBeGreaterThan(0.9)
  })

  it('updateMemoryEmbedding changes which queries match', async () => {
    const mem = await storeMemory(db, {
      content: 'A fact that changes topic cluster',
      category: 'general',
      source: 'user',
      embedding: JSON.stringify(memoryEmbeddings.miso), // starts in pet cluster
    })

    // Initially findable by pet query
    let results = await recallMemories(db, 'xyzzy', {
      queryEmbedding: queryEmbeddings.pet,
    })
    expect(results.find((r) => r.id === mem.id)).toBeDefined()

    // Re-embed into work cluster
    await updateMemoryEmbedding(db, mem.id, memoryEmbeddings.datapipe)

    // No longer findable by pet query
    results = await recallMemories(db, 'xyzzy', {
      queryEmbedding: queryEmbeddings.pet,
    })
    expect(results.find((r) => r.id === mem.id)).toBeUndefined()

    // Now findable by work query
    results = await recallMemories(db, 'xyzzy', {
      queryEmbedding: queryEmbeddings.work,
    })
    expect(results.find((r) => r.id === mem.id)).toBeDefined()
  })
})

// ── Graph node write integrity ──────────────────────────────────────

describe('graph node writes', () => {
  it('upsertNode normalizes name to lowercase', async () => {
    const node = await upsertNode(db, { name: 'AlExAnDeR', type: 'person' })
    expect(node.name).toBe('alexander')
    expect(node.display_name).toBe('AlExAnDeR')
  })

  it('upsertNode is idempotent on same name+type', async () => {
    const first = await upsertNode(db, { name: 'Alex', type: 'person' })
    const second = await upsertNode(db, { name: 'Alex', type: 'person' })
    expect(first.id).toBe(second.id)
  })

  it('upsertNode creates separate nodes for different types', async () => {
    const person = await upsertNode(db, { name: 'Rust', type: 'person' })
    const concept = await upsertNode(db, { name: 'Rust', type: 'concept' })
    expect(person.id).not.toBe(concept.id)
  })

  it('findNodeByName is case-insensitive', async () => {
    await upsertNode(db, { name: 'Portland', type: 'place' })

    const found1 = await findNodeByName(db, 'Portland')
    const found2 = await findNodeByName(db, 'portland')
    const found3 = await findNodeByName(db, 'PORTLAND')

    expect(found1).toBeDefined()
    expect(found1!.id).toBe(found2!.id)
    expect(found2!.id).toBe(found3!.id)
  })

  it('upsertNode fills description on existing node without one', async () => {
    const bare = await upsertNode(db, { name: 'DataPipe', type: 'entity' })
    expect(bare.description).toBeNull()

    const updated = await upsertNode(db, {
      name: 'DataPipe',
      type: 'entity',
      description: 'Real-time data pipeline company',
    })

    expect(updated.id).toBe(bare.id)
    expect(updated.description).toBe('Real-time data pipeline company')
  })

  it('searchNodes finds nodes by partial name match', async () => {
    await upsertNode(db, { name: 'Portland', type: 'place' })
    await upsertNode(db, { name: 'Port Angeles', type: 'place' })

    const results = await searchNodes(db, 'port', 10)
    expect(results.length).toBe(2)
  })
})

// ── Graph edge write integrity ──────────────────────────────────────

describe('graph edge writes', () => {
  it('upsertEdge with memory_id → getRelatedMemoryIds returns it', async () => {
    const alex = await upsertNode(db, { name: 'Alex', type: 'person' })
    const miso = await upsertNode(db, { name: 'Miso', type: 'entity' })
    const mem = await storeMemory(db, {
      content: 'Alex has a cat named Miso',
      source: 'user',
    })

    await upsertEdge(db, {
      source_id: alex.id,
      target_id: miso.id,
      relation: 'owns',
      memory_id: mem.id,
    })

    const memIds = await getRelatedMemoryIds(db, [alex.id, miso.id])
    expect(memIds).toContain(mem.id)
  })

  it('upsertEdge without memory_id → getRelatedMemoryIds skips it', async () => {
    const a = await upsertNode(db, { name: 'A', type: 'entity' })
    const b = await upsertNode(db, { name: 'B', type: 'entity' })

    await upsertEdge(db, {
      source_id: a.id,
      target_id: b.id,
      relation: 'related_to',
      // no memory_id
    })

    const memIds = await getRelatedMemoryIds(db, [a.id, b.id])
    expect(memIds).toHaveLength(0)
  })

  it('upsertEdge increments weight on duplicate', async () => {
    const a = await upsertNode(db, { name: 'A', type: 'entity' })
    const b = await upsertNode(db, { name: 'B', type: 'entity' })

    const first = await upsertEdge(db, {
      source_id: a.id,
      target_id: b.id,
      relation: 'knows',
    })
    expect(first.weight).toBe(1)

    const second = await upsertEdge(db, {
      source_id: a.id,
      target_id: b.id,
      relation: 'knows',
    })
    expect(second.weight).toBe(2)

    const third = await upsertEdge(db, {
      source_id: a.id,
      target_id: b.id,
      relation: 'knows',
    })
    expect(third.weight).toBe(3)
  })

  it('different relations create separate edges', async () => {
    const alex = await upsertNode(db, { name: 'Alex', type: 'person' })
    const portland = await upsertNode(db, { name: 'Portland', type: 'place' })

    await upsertEdge(db, {
      source_id: alex.id,
      target_id: portland.id,
      relation: 'lives_in',
    })
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: portland.id,
      relation: 'was_born_in',
    })

    const edges = await getNodeEdges(db, alex.id)
    const portlandEdges = edges.filter((e) => e.target_id === portland.id)
    expect(portlandEdges).toHaveLength(2)
    expect(portlandEdges.map((e) => e.relation).sort()).toEqual(['lives_in', 'was_born_in'])
  })

  it('edges reachable from both source and target via traversal', async () => {
    const alex = await upsertNode(db, { name: 'Alex', type: 'person' })
    const miso = await upsertNode(db, { name: 'Miso', type: 'entity' })

    await upsertEdge(db, {
      source_id: alex.id,
      target_id: miso.id,
      relation: 'owns',
    })

    // Traverse from Alex → should reach Miso
    const fromAlex = await traverseGraph(db, alex.id, 1)
    expect(fromAlex.map((t) => t.node.id)).toContain(miso.id)

    // Traverse from Miso → should reach Alex (edges are bidirectional in traversal)
    const fromMiso = await traverseGraph(db, miso.id, 1)
    expect(fromMiso.map((t) => t.node.id)).toContain(alex.id)
  })
})

// ── Write → retrieval roundtrip ─────────────────────────────────────

describe('write → retrieval roundtrip', () => {
  it('memory findable via all three paths: FTS5, embedding, graph', async () => {
    // 1. Store memory with embedding
    const mem = await storeMemory(db, {
      content: 'Alex has a cat named Miso who is 3 years old',
      category: 'personal',
      tags: 'pet,cat',
      source: 'user',
      embedding: JSON.stringify(memoryEmbeddings.miso),
    })

    // 2. Create graph nodes + edge linked to this memory
    const alex = await upsertNode(db, { name: 'Alex', type: 'person' })
    const miso = await upsertNode(db, { name: 'Miso', type: 'entity' })
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: miso.id,
      relation: 'owns',
      memory_id: mem.id,
    })

    // Path 1: FTS5 keyword search
    const ftsResults = await recallMemories(db, 'cat Miso')
    expect(ftsResults.find((r) => r.id === mem.id)).toBeDefined()

    // Path 2: Embedding cosine similarity
    const embResults = await recallMemories(db, 'xyzzy_no_keyword', {
      queryEmbedding: queryEmbeddings.pet,
    })
    const embMatch = embResults.find((r) => r.id === mem.id)
    expect(embMatch).toBeDefined()
    expect(embMatch!.score).toBeGreaterThan(0.9)

    // Path 3: Graph traversal → getRelatedMemoryIds
    const traversed = await traverseGraph(db, alex.id, 1)
    const reachedNodeIds = [alex.id, ...traversed.map((t) => t.node.id)]
    const graphMemIds = await getRelatedMemoryIds(db, reachedNodeIds)
    expect(graphMemIds).toContain(mem.id)
  })

  it('archived memory excluded from all recall paths', async () => {
    const mem = await storeMemory(db, {
      content: 'Alex used to have a hamster named Biscuit',
      category: 'personal',
      tags: 'pet,hamster',
      source: 'user',
      embedding: JSON.stringify(memoryEmbeddings.miso), // pet direction
    })

    const alex = await upsertNode(db, { name: 'Alex', type: 'person' })
    const biscuit = await upsertNode(db, { name: 'Biscuit', type: 'entity' })
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: biscuit.id,
      relation: 'owned',
      memory_id: mem.id,
    })

    // Archive the memory
    await forgetMemory(db, mem.id)

    // FTS5: excluded
    const ftsResults = await recallMemories(db, 'hamster Biscuit')
    expect(ftsResults.find((r) => r.id === mem.id)).toBeUndefined()

    // Embedding: excluded (recallMemories filters archived_at IS NULL)
    const embResults = await recallMemories(db, 'xyzzy', {
      queryEmbedding: queryEmbeddings.pet,
    })
    expect(embResults.find((r) => r.id === mem.id)).toBeUndefined()

    // Graph: edge still exists, getRelatedMemoryIds still returns the ID...
    const graphMemIds = await getRelatedMemoryIds(db, [alex.id, biscuit.id])
    expect(graphMemIds).toContain(mem.id)

    // ...but fetching the memory with archived_at filter excludes it
    // (this is what memory_recall tool does)
    const fetchedMems = await db
      .selectFrom('memories')
      .selectAll()
      .where('id', 'in', graphMemIds)
      .where('archived_at', 'is', null)
      .execute()
    expect(fetchedMems.find((m) => m.id === mem.id)).toBeUndefined()
  })
})

// ── Graph write patterns (simulating processMemoryForGraph) ─────────

describe('graph write patterns — entity extraction simulation', () => {
  it('multiple memories build up a connected graph', async () => {
    // Simulate processing three memories through the graph pipeline:
    // Memory 1: "Alex works at DataPipe"
    const mem1 = await storeMemory(db, {
      content: 'Alex works at DataPipe as a backend engineer',
      source: 'user',
      category: 'work',
    })
    // Simulated extraction: entities=[Alex(person), DataPipe(entity)], rels=[Alex works_at DataPipe]
    const alex = await upsertNode(db, { name: 'Alex', type: 'person' })
    const datapipe = await upsertNode(db, { name: 'DataPipe', type: 'entity' })
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: datapipe.id,
      relation: 'works_at',
      memory_id: mem1.id,
    })

    // Memory 2: "Alex lives in Portland"
    const mem2 = await storeMemory(db, {
      content: 'Alex lives in Portland, Oregon',
      source: 'user',
      category: 'personal',
    })
    const alex2 = await upsertNode(db, { name: 'Alex', type: 'person' })
    const portland = await upsertNode(db, { name: 'Portland', type: 'place' })
    await upsertEdge(db, {
      source_id: alex2.id,
      target_id: portland.id,
      relation: 'lives_in',
      memory_id: mem2.id,
    })

    // Memory 3: "DataPipe is based in Portland"
    const mem3 = await storeMemory(db, {
      content: 'DataPipe is headquartered in Portland',
      source: 'user',
      category: 'work',
    })
    const datapipe2 = await upsertNode(db, { name: 'DataPipe', type: 'entity' })
    const portland2 = await upsertNode(db, { name: 'Portland', type: 'place' })
    await upsertEdge(db, {
      source_id: datapipe2.id,
      target_id: portland2.id,
      relation: 'based_in',
      memory_id: mem3.id,
    })

    // Verify: Alex node was reused, not duplicated
    expect(alex.id).toBe(alex2.id)
    expect(datapipe.id).toBe(datapipe2.id)
    expect(portland.id).toBe(portland2.id)

    // Verify: traversal from Portland reaches both Alex and DataPipe
    const fromPortland = await traverseGraph(db, portland.id, 1)
    const reached = fromPortland.map((t) => t.node.id)
    expect(reached).toContain(alex.id)
    expect(reached).toContain(datapipe.id)

    // Verify: all three memories reachable from the Portland neighborhood
    const allNodes = [portland.id, ...reached]
    const memIds = await getRelatedMemoryIds(db, allNodes)
    expect(memIds).toContain(mem1.id)
    expect(memIds).toContain(mem2.id)
    expect(memIds).toContain(mem3.id)
  })

  it('relationship referencing unknown entity creates generic node', async () => {
    // processMemoryForGraph creates 'entity' type nodes for unknown rel endpoints
    const mem = await storeMemory(db, {
      content: 'Alex mentioned Sarah but extraction only found Alex as an entity',
      source: 'user',
    })

    // Extraction found Alex but not Sarah
    const alex = await upsertNode(db, { name: 'Alex', type: 'person' })
    // Relationship references Sarah → create as generic entity (like processMemoryForGraph does)
    let sarah = await findNodeByName(db, 'Sarah')
    if (!sarah) {
      sarah = await upsertNode(db, { name: 'Sarah', type: 'entity' })
    }
    await upsertEdge(db, {
      source_id: alex.id,
      target_id: sarah.id,
      relation: 'knows',
      memory_id: mem.id,
    })

    // Sarah should be findable and connected
    const found = await findNodeByName(db, 'sarah')
    expect(found).toBeDefined()
    expect(found!.node_type).toBe('entity') // generic type

    // Later extraction provides proper type — upsertNode returns existing
    const sarah2 = await upsertNode(db, { name: 'Sarah', type: 'entity' })
    expect(sarah2.id).toBe(sarah.id) // same node
  })

  it('repeated processing of same fact increments edge weight', async () => {
    const alex = await upsertNode(db, { name: 'Alex', type: 'person' })
    const portland = await upsertNode(db, { name: 'Portland', type: 'place' })

    // Three separate memories all mention Alex lives in Portland
    const mems = await Promise.all([
      storeMemory(db, { content: 'Alex lives in Portland', source: 'user' }),
      storeMemory(db, { content: 'Alex resides in Portland, OR', source: 'user' }),
      storeMemory(db, { content: 'Alex moved to Portland last year', source: 'user' }),
    ])

    for (const mem of mems) {
      await upsertEdge(db, {
        source_id: alex.id,
        target_id: portland.id,
        relation: 'lives_in',
        memory_id: mem.id,
      })
    }

    // Edge weight should be 3
    const edges = await getNodeEdges(db, alex.id)
    const livesIn = edges.find(
      (e) => e.target_id === portland.id && e.relation === 'lives_in',
    )
    expect(livesIn).toBeDefined()
    expect(livesIn!.weight).toBe(3)
  })

  it('hub node connects disparate facts for cross-topic discovery', async () => {
    // This tests the key value proposition of the graph:
    // searching for "Miso" (a cat) can surface "shellfish allergy" (health)
    // because they're both connected to Alex

    const mem1 = await storeMemory(db, {
      content: 'Alex has a cat named Miso',
      source: 'user',
      embedding: JSON.stringify(memoryEmbeddings.miso),
    })
    const mem2 = await storeMemory(db, {
      content: 'Alex is allergic to shellfish',
      source: 'user',
      embedding: JSON.stringify(memoryEmbeddings.shellfish),
    })

    const alex = await upsertNode(db, { name: 'Alex', type: 'person' })
    const miso = await upsertNode(db, { name: 'Miso', type: 'entity' })
    const shellfish = await upsertNode(db, { name: 'Shellfish', type: 'concept' })

    await upsertEdge(db, { source_id: alex.id, target_id: miso.id, relation: 'owns', memory_id: mem1.id })
    await upsertEdge(db, { source_id: alex.id, target_id: shellfish.id, relation: 'allergic_to', memory_id: mem2.id })

    // Direct recall for "Miso" — only finds cat memory (different embedding clusters)
    const directResults = await recallMemories(db, 'Miso', {
      queryEmbedding: queryEmbeddings.pet,
    })
    const directIds = new Set(directResults.map((r) => r.id))
    expect(directIds.has(mem1.id)).toBe(true)
    expect(directIds.has(mem2.id)).toBe(false) // shellfish allergy NOT in direct results

    // Graph expansion from Miso → Alex → Shellfish → surfaces allergy memory
    const misoNode = await findNodeByName(db, 'miso')
    const traversed = await traverseGraph(db, misoNode!.id, 2)
    const allNodeIds = [misoNode!.id, ...traversed.map((t) => t.node.id)]
    const graphMemIds = await getRelatedMemoryIds(db, allNodeIds)

    // Graph found the allergy memory through the Alex hub!
    expect(graphMemIds).toContain(mem2.id)

    // Combined: direct recall found pet fact, graph added health fact
    const allMemIds = new Set([...directIds, ...graphMemIds])
    expect(allMemIds.has(mem1.id)).toBe(true) // cat
    expect(allMemIds.has(mem2.id)).toBe(true) // allergy — cross-topic discovery
  })
})
