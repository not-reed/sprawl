import { Hono } from 'hono'
import type { Env } from '../server.js'
import {
  searchNodes,
  getNodeEdges,
  traverseGraph,
  getRelatedMemoryIds,
} from '../../src/memory/graph/queries.js'

export const graphRoutes = new Hono<Env>()

graphRoutes.get('/nodes/search', async (c) => {
  const db = c.get('db')
  const q = c.req.query('q') ?? ''
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)

  if (!q.trim()) return c.json({ nodes: [] })

  const nodes = await searchNodes(db, q, limit)
  const cleaned = nodes.map(({ embedding, ...rest }) => rest)

  return c.json({ nodes: cleaned })
})

graphRoutes.get('/nodes/:id', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')

  const node = await db
    .selectFrom('graph_nodes')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()

  if (!node) return c.json({ error: 'Not found' }, 404)

  const { embedding, ...rest } = node
  return c.json(rest)
})

graphRoutes.get('/nodes/:id/edges', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')

  const edges = await getNodeEdges(db, id)
  return c.json({ edges })
})

graphRoutes.get('/nodes/:id/traverse', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')
  const depth = Math.min(Number(c.req.query('depth') ?? 2), 4)

  const results = await traverseGraph(db, id, depth)

  const nodes = results.map(({ node: { embedding, ...rest }, depth, via_relation }) => ({
    ...rest,
    depth,
    via_relation,
  }))

  return c.json({ nodes })
})

graphRoutes.get('/nodes/:id/memories', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')

  const memoryIds = await getRelatedMemoryIds(db, [id])

  if (memoryIds.length === 0) return c.json({ memories: [] })

  const memories = await db
    .selectFrom('memories')
    .selectAll()
    .where('id', 'in', memoryIds)
    .where('archived_at', 'is', null)
    .orderBy('created_at', 'desc')
    .execute()

  const cleaned = memories.map(({ embedding, ...rest }) => rest)
  return c.json({ memories: cleaned })
})

graphRoutes.get('/full', async (c) => {
  const db = c.get('db')
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 500)

  // Get top nodes by edge count
  const nodes = await db
    .selectFrom('graph_nodes')
    .selectAll()
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .execute()

  const nodeIds = nodes.map((n) => n.id)

  let edges: any[] = []
  if (nodeIds.length > 0) {
    edges = await db
      .selectFrom('graph_edges')
      .selectAll()
      .where((eb) =>
        eb.and([
          eb('source_id', 'in', nodeIds),
          eb('target_id', 'in', nodeIds),
        ]),
      )
      .execute()
  }

  const cleanedNodes = nodes.map(({ embedding, ...rest }) => rest)

  return c.json({ nodes: cleanedNodes, edges })
})
