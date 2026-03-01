import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Kysely } from 'kysely'
import { createDb } from '@repo/db'
import type { Database } from '../../db/schema.js'
import * as migration001 from '../../db/migrations/001-initial.js'
import * as migration005 from '../../db/migrations/005-graph-memory.js'
import {
  upsertNode,
  upsertEdge,
  findNodeByName,
  searchNodes,
  traverseGraph,
  getNodeEdges,
  getRelatedMemoryIds,
  getMemoryNodes,
  storeMemory,
} from '@repo/cairn'
import * as migration002 from '../../db/migrations/002-fts5-and-embeddings.js'

let db: Kysely<Database>

beforeEach(async () => {
  const result = createDb<Database>(':memory:')
  db = result.db
  await migration001.up(db as Kysely<unknown>)
  await migration002.up(db as Kysely<unknown>)
  await migration005.up(db as Kysely<unknown>)
})

afterEach(async () => {
  await db.destroy()
})

describe('upsertNode', () => {
  it('creates a new node', async () => {
    const node = await upsertNode(db, {
      name: 'Alice',
      type: 'person',
      description: 'A friend',
    })

    expect(node.name).toBe('alice')
    expect(node.display_name).toBe('Alice')
    expect(node.node_type).toBe('person')
    expect(node.description).toBe('A friend')
  })

  it('returns existing node on duplicate name+type', async () => {
    const first = await upsertNode(db, { name: 'Alice', type: 'person' })
    const second = await upsertNode(db, { name: 'alice', type: 'person' })

    expect(second.id).toBe(first.id)
  })

  it('fills in description if existing node has none', async () => {
    await upsertNode(db, { name: 'Alice', type: 'person' })
    const updated = await upsertNode(db, {
      name: 'Alice',
      type: 'person',
      description: 'Best friend',
    })

    expect(updated.description).toBe('Best friend')
  })

  it('does not overwrite existing description', async () => {
    await upsertNode(db, {
      name: 'Alice',
      type: 'person',
      description: 'Original',
    })
    const again = await upsertNode(db, {
      name: 'Alice',
      type: 'person',
      description: 'New description',
    })

    expect(again.description).toBe('Original')
  })

  it('allows same name with different types', async () => {
    const person = await upsertNode(db, { name: 'Java', type: 'concept' })
    const place = await upsertNode(db, { name: 'Java', type: 'place' })

    expect(person.id).not.toBe(place.id)
  })
})

describe('upsertEdge', () => {
  it('creates an edge between two nodes', async () => {
    const alice = await upsertNode(db, { name: 'Alice', type: 'person' })
    const bob = await upsertNode(db, { name: 'Bob', type: 'person' })

    const edge = await upsertEdge(db, {
      source_id: alice.id,
      target_id: bob.id,
      relation: 'knows',
    })

    expect(edge.source_id).toBe(alice.id)
    expect(edge.target_id).toBe(bob.id)
    expect(edge.relation).toBe('knows')
    expect(edge.weight).toBe(1)
  })

  it('increments weight on duplicate edge', async () => {
    const alice = await upsertNode(db, { name: 'Alice', type: 'person' })
    const bob = await upsertNode(db, { name: 'Bob', type: 'person' })

    await upsertEdge(db, { source_id: alice.id, target_id: bob.id, relation: 'knows' })
    const second = await upsertEdge(db, { source_id: alice.id, target_id: bob.id, relation: 'knows' })

    expect(second.weight).toBe(2)
  })

  it('stores memory_id on edge', async () => {
    const alice = await upsertNode(db, { name: 'Alice', type: 'person' })
    const bob = await upsertNode(db, { name: 'Bob', type: 'person' })
    const mem = await storeMemory(db, { content: 'Alice and Bob are friends', source: 'user' })

    const edge = await upsertEdge(db, {
      source_id: alice.id,
      target_id: bob.id,
      relation: 'friends with',
      memory_id: mem.id,
    })

    expect(edge.memory_id).toBe(mem.id)
  })
})

describe('findNodeByName', () => {
  it('finds node case-insensitively', async () => {
    await upsertNode(db, { name: 'Alice', type: 'person' })

    const found = await findNodeByName(db, 'ALICE')
    expect(found).toBeDefined()
    expect(found!.display_name).toBe('Alice')
  })

  it('filters by type when specified', async () => {
    await upsertNode(db, { name: 'Java', type: 'concept' })
    await upsertNode(db, { name: 'Java', type: 'place' })

    const concept = await findNodeByName(db, 'java', 'concept')
    expect(concept!.node_type).toBe('concept')
  })

  it('returns undefined for missing node', async () => {
    const found = await findNodeByName(db, 'nobody')
    expect(found).toBeUndefined()
  })
})

describe('searchNodes', () => {
  it('finds nodes by partial name match', async () => {
    await upsertNode(db, { name: 'Alice Smith', type: 'person' })
    await upsertNode(db, { name: 'Bob Jones', type: 'person' })

    const results = await searchNodes(db, 'alice')
    expect(results).toHaveLength(1)
    expect(results[0].display_name).toBe('Alice Smith')
  })

  it('returns empty array for no matches', async () => {
    const results = await searchNodes(db, 'nobody')
    expect(results).toHaveLength(0)
  })
})

describe('getNodeEdges', () => {
  it('returns edges where node is source or target', async () => {
    const alice = await upsertNode(db, { name: 'Alice', type: 'person' })
    const bob = await upsertNode(db, { name: 'Bob', type: 'person' })
    const carol = await upsertNode(db, { name: 'Carol', type: 'person' })

    await upsertEdge(db, { source_id: alice.id, target_id: bob.id, relation: 'knows' })
    await upsertEdge(db, { source_id: carol.id, target_id: alice.id, relation: 'works with' })

    const edges = await getNodeEdges(db, alice.id)
    expect(edges).toHaveLength(2)
  })
})

describe('traverseGraph', () => {
  it('traverses 1 hop from start node', async () => {
    const alice = await upsertNode(db, { name: 'Alice', type: 'person' })
    const bob = await upsertNode(db, { name: 'Bob', type: 'person' })
    const carol = await upsertNode(db, { name: 'Carol', type: 'person' })

    await upsertEdge(db, { source_id: alice.id, target_id: bob.id, relation: 'knows' })
    await upsertEdge(db, { source_id: bob.id, target_id: carol.id, relation: 'knows' })

    const results = await traverseGraph(db, alice.id, 1)
    expect(results).toHaveLength(1)
    expect(results[0].node.name).toBe('bob')
    expect(results[0].depth).toBe(1)
  })

  it('traverses 2 hops from start node', async () => {
    const alice = await upsertNode(db, { name: 'Alice', type: 'person' })
    const bob = await upsertNode(db, { name: 'Bob', type: 'person' })
    const carol = await upsertNode(db, { name: 'Carol', type: 'person' })

    await upsertEdge(db, { source_id: alice.id, target_id: bob.id, relation: 'knows' })
    await upsertEdge(db, { source_id: bob.id, target_id: carol.id, relation: 'knows' })

    const results = await traverseGraph(db, alice.id, 2)
    expect(results).toHaveLength(2)

    const names = results.map((r) => r.node.name)
    expect(names).toContain('bob')
    expect(names).toContain('carol')
  })

  it('does not revisit nodes (prevents cycles)', async () => {
    const alice = await upsertNode(db, { name: 'Alice', type: 'person' })
    const bob = await upsertNode(db, { name: 'Bob', type: 'person' })

    // Create a cycle: Alice → Bob → Alice
    await upsertEdge(db, { source_id: alice.id, target_id: bob.id, relation: 'knows' })
    await upsertEdge(db, { source_id: bob.id, target_id: alice.id, relation: 'knows' })

    const results = await traverseGraph(db, alice.id, 3)
    // Should only find Bob (Alice is start, not revisited)
    expect(results).toHaveLength(1)
    expect(results[0].node.name).toBe('bob')
  })

  it('returns empty for isolated node', async () => {
    const alone = await upsertNode(db, { name: 'Alone', type: 'person' })

    const results = await traverseGraph(db, alone.id, 2)
    expect(results).toHaveLength(0)
  })
})

describe('getRelatedMemoryIds', () => {
  it('finds memory IDs connected to given nodes', async () => {
    const alice = await upsertNode(db, { name: 'Alice', type: 'person' })
    const bob = await upsertNode(db, { name: 'Bob', type: 'person' })
    const mem = await storeMemory(db, { content: 'Alice knows Bob', source: 'user' })

    await upsertEdge(db, {
      source_id: alice.id,
      target_id: bob.id,
      relation: 'knows',
      memory_id: mem.id,
    })

    const memoryIds = await getRelatedMemoryIds(db, [alice.id])
    expect(memoryIds).toContain(mem.id)
  })

  it('returns empty for nodes with no memory links', async () => {
    const alice = await upsertNode(db, { name: 'Alice', type: 'person' })
    const bob = await upsertNode(db, { name: 'Bob', type: 'person' })
    await upsertEdge(db, { source_id: alice.id, target_id: bob.id, relation: 'knows' })

    const memoryIds = await getRelatedMemoryIds(db, [alice.id])
    expect(memoryIds).toHaveLength(0)
  })

  it('returns empty for empty node list', async () => {
    const memoryIds = await getRelatedMemoryIds(db, [])
    expect(memoryIds).toHaveLength(0)
  })
})

describe('getMemoryNodes', () => {
  it('finds nodes connected to a memory', async () => {
    const alice = await upsertNode(db, { name: 'Alice', type: 'person' })
    const bob = await upsertNode(db, { name: 'Bob', type: 'person' })
    const mem = await storeMemory(db, { content: 'Alice knows Bob', source: 'user' })

    await upsertEdge(db, {
      source_id: alice.id,
      target_id: bob.id,
      relation: 'knows',
      memory_id: mem.id,
    })

    const nodes = await getMemoryNodes(db, mem.id)
    expect(nodes).toHaveLength(2)

    const names = nodes.map((n) => n.name)
    expect(names).toContain('alice')
    expect(names).toContain('bob')
  })

  it('returns empty for memory with no graph links', async () => {
    const nodes = await getMemoryNodes(db, 'mem-nonexistent')
    expect(nodes).toHaveLength(0)
  })
})
