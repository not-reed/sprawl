import { Hono } from 'hono'
import type { Env } from '../server.js'
import { recallMemories, getRecentMemories } from '../../src/db/queries.js'
import { getMemoryNodes } from '../../src/memory/graph/queries.js'
import { generateEmbedding } from '../../src/embeddings.js'
import { env } from '../env.js'

export const memoriesRoutes = new Hono<Env>()

memoriesRoutes.get('/search', async (c) => {
  const db = c.get('db')
  const q = c.req.query('q') ?? ''
  const mode = c.req.query('mode') ?? 'auto'
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  const category = c.req.query('category')

  if (!q.trim()) {
    return c.json({ results: [] })
  }

  let queryEmbedding: number[] | undefined

  if ((mode === 'auto' || mode === 'embedding') && env.OPENROUTER_API_KEY) {
    try {
      queryEmbedding = await generateEmbedding(
        env.OPENROUTER_API_KEY,
        q,
        env.EMBEDDING_MODEL,
      )
    } catch {
      // Fall through without embeddings
    }
  }

  const opts: Parameters<typeof recallMemories>[2] = {
    limit,
    category: category || undefined,
  }

  if (mode === 'fts') {
    // FTS only — don't pass embedding
  } else if (mode === 'keyword') {
    // Keyword only — don't pass embedding, and we need a workaround
    // recallMemories always tries FTS first, so for keyword-only we skip it
  } else {
    opts.queryEmbedding = queryEmbedding
  }

  const results = await recallMemories(db, q, opts)

  // Strip embedding field from response (large, not useful to client)
  const cleaned = results.map(({ embedding, ...rest }) => rest)

  return c.json({ results: cleaned })
})

memoriesRoutes.get('/recent', async (c) => {
  const db = c.get('db')
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)

  const results = await getRecentMemories(db, limit)
  const cleaned = results.map(({ embedding, ...rest }) => rest)

  return c.json({ results: cleaned })
})

memoriesRoutes.get('/:id', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')

  const memory = await db
    .selectFrom('memories')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()

  if (!memory) return c.json({ error: 'Not found' }, 404)

  const { embedding, ...rest } = memory
  return c.json(rest)
})

memoriesRoutes.get('/:id/nodes', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')

  const nodes = await getMemoryNodes(db, id)
  const cleaned = nodes.map(({ embedding, ...rest }) => rest)

  return c.json({ nodes: cleaned })
})
