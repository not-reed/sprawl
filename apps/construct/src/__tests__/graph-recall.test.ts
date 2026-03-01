/**
 * Pipeline tests for graph-augmented memory retrieval.
 *
 * Tests the graph expansion path: searchNodes → traverseGraph →
 * getRelatedMemoryIds → fetch related memories. This is the logic
 * used by memory_recall's graph expansion.
 *
 * No API key needed — uses synthetic data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import {
  recallMemories,
  searchNodes,
  traverseGraph,
  getRelatedMemoryIds,
} from '@repo/cairn'
import { setupDb, seedMemories, seedGraph } from './fixtures.js'

let db: Kysely<Database>
let memIds: Record<string, string>
let nodeIds: Record<string, string>

beforeEach(async () => {
  db = await setupDb()
  const seeded = await seedMemories(db)
  memIds = seeded.ids
  const graph = await seedGraph(db, memIds)
  nodeIds = graph.nodeIds
})

afterEach(async () => {
  await db.destroy()
})

/**
 * Replicate the graph expansion logic from memory_recall tool.
 * Given a query, search nodes, traverse, collect related memory IDs.
 */
async function graphExpand(
  query: string,
): Promise<{ relatedMemIds: string[]; matchedNodeIds: string[] }> {
  const nodes = await searchNodes(db, query, 5)
  if (nodes.length === 0) return { relatedMemIds: [], matchedNodeIds: [] }

  const allNodeIds = new Set<string>()
  for (const node of nodes) {
    allNodeIds.add(node.id)
    const traversed = await traverseGraph(db, node.id, 2)
    for (const t of traversed) {
      allNodeIds.add(t.node.id)
    }
  }

  const relatedMemIds = await getRelatedMemoryIds(db, [...allNodeIds])
  return { relatedMemIds, matchedNodeIds: nodes.map((n) => n.id) }
}

describe('graph-augmented recall — graph surfaces related memories', () => {
  it('Portland search traverses to DataPipe via Alex', async () => {
    // Search "portland" → finds Portland node → traverses Alex→DataPipe
    // → surfaces DataPipe memory that wouldn't appear in text search for "portland"
    const { relatedMemIds, matchedNodeIds } = await graphExpand('portland')

    // Portland node should be matched
    expect(matchedNodeIds).toContain(nodeIds.portland)

    // Related memories should include portland memory (direct edge)
    expect(relatedMemIds).toContain(memIds.portland)

    // And DataPipe memory (via Alex→Portland edge + Alex→DataPipe edge)
    expect(relatedMemIds).toContain(memIds.datapipe)
  })

  it('Miso search reaches all Alex-connected memories', async () => {
    const { relatedMemIds } = await graphExpand('miso')

    // Direct: Alex→Miso edge → miso memory
    expect(relatedMemIds).toContain(memIds.miso)

    // Via Alex hub: should reach other Alex-connected memories
    expect(relatedMemIds).toContain(memIds.portland)
    expect(relatedMemIds).toContain(memIds.datapipe)
    expect(relatedMemIds).toContain(memIds.rust)
    expect(relatedMemIds).toContain(memIds.shellfish)
  })

  it('DataPipe search reaches Portland and Alex-connected memories', async () => {
    const { relatedMemIds, matchedNodeIds } = await graphExpand('datapipe')

    expect(matchedNodeIds).toContain(nodeIds.datapipe)

    // Direct: Alex→DataPipe → datapipe memory
    expect(relatedMemIds).toContain(memIds.datapipe)

    // Via DataPipe→Portland edge (no memory) + Alex→Portland edge → portland memory
    expect(relatedMemIds).toContain(memIds.portland)
  })
})

describe('graph-augmented recall — merge with direct recall', () => {
  it('combining direct recall + graph expansion produces no duplicates', async () => {
    // Direct recall for "Miso" → finds cat memory via FTS/keyword
    const directResults = await recallMemories(db, 'Miso')
    const directIds = new Set(directResults.map((r) => r.id))

    // Graph expansion for "miso"
    const { relatedMemIds } = await graphExpand('miso')

    // Merge like the tool does: direct first, then graph results not in direct
    const seen = new Set(directIds)
    const graphOnly = relatedMemIds.filter((id) => !seen.has(id))

    // Cat memory should be in direct results
    expect(directIds.has(memIds.miso)).toBe(true)

    // Graph should add memories not in direct results
    // (e.g. datapipe, portland, etc. depending on what FTS matched)
    const allIds = [...directIds, ...graphOnly]
    const uniqueIds = new Set(allIds)
    expect(uniqueIds.size).toBe(allIds.length) // no duplicates
  })
})

describe('graph-augmented recall — isolated nodes', () => {
  it('query matching no nodes returns empty', async () => {
    const { relatedMemIds, matchedNodeIds } = await graphExpand('xyzzy_nonexistent')

    expect(matchedNodeIds).toHaveLength(0)
    expect(relatedMemIds).toHaveLength(0)
  })

  it('a node with no edges returns only its own edge memories', async () => {
    // Create an isolated node with no connections
    const { upsertNode } = await import('@repo/cairn')
    const isolated = await upsertNode(db, {
      name: 'IsolatedThing',
      type: 'concept',
      description: 'A thing with no connections',
    })

    const nodes = await searchNodes(db, 'isolatedthing', 5)
    expect(nodes.length).toBeGreaterThan(0)

    // Traverse from isolated node — should find no neighbors
    const traversed = await traverseGraph(db, isolated.id, 2)
    expect(traversed).toHaveLength(0)

    // getRelatedMemoryIds with just the isolated node — no edges, no memories
    const memoryIds = await getRelatedMemoryIds(db, [isolated.id])
    expect(memoryIds).toHaveLength(0)
  })
})

describe('traverseGraph depth control', () => {
  it('depth=1 reaches direct neighbors only', async () => {
    // From Portland: depth=1 should reach Alex and DataPipe (direct edges)
    const traversed = await traverseGraph(db, nodeIds.portland, 1)
    const reachedIds = traversed.map((t) => t.node.id)

    expect(reachedIds).toContain(nodeIds.alex)
    expect(reachedIds).toContain(nodeIds.datapipe) // DataPipe→Portland edge

    // Miso is 2 hops away (Portland→Alex→Miso) — should NOT be reached at depth=1
    expect(reachedIds).not.toContain(nodeIds.miso)
  })

  it('depth=2 reaches 2-hop neighbors', async () => {
    // From Portland: depth=2 should reach Alex's other connections
    const traversed = await traverseGraph(db, nodeIds.portland, 2)
    const reachedIds = traversed.map((t) => t.node.id)

    expect(reachedIds).toContain(nodeIds.alex)
    expect(reachedIds).toContain(nodeIds.miso) // 2 hops: Portland→Alex→Miso
    expect(reachedIds).toContain(nodeIds.rust)
    expect(reachedIds).toContain(nodeIds.shellfish)
  })
})
