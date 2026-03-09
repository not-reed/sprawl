import { Hono } from 'hono'
import type { Env } from '../server.js'
import {
  getSession,
  updateSession,
} from '../db/queries.js'
import { MemoryManager, type WorkerModelConfig } from '@repo/cairn'
import { env } from '../env.js'

export const sessionRoutes = new Hono<Env>()

// Get session detail
sessionRoutes.get('/sessions/:id', async (c) => {
  const db = c.get('db')
  const session = await getSession(db, c.req.param('id'))
  if (!session) return c.json({ error: 'Not found' }, 404)
  return c.json(session)
})

// Update session (toggle mode, rename, complete)
sessionRoutes.patch('/sessions/:id', async (c) => {
  const db = c.get('db')
  const body = await c.req.json<{ name?: string; mode?: string; status?: string }>()
  const session = await updateSession(db, c.req.param('id'), body)
  if (!session) return c.json({ error: 'Not found' }, 404)
  return c.json(session)
})

// Get observations for session sidebar
sessionRoutes.get('/sessions/:id/observations', async (c) => {
  const db = c.get('db')
  const session = await getSession(db, c.req.param('id'))
  if (!session) return c.json({ error: 'Not found' }, 404)

  const workerConfig: WorkerModelConfig | null = env.MEMORY_WORKER_MODEL
    ? { apiKey: env.OPENROUTER_API_KEY, model: env.MEMORY_WORKER_MODEL, extraBody: { reasoning: { max_tokens: 1 } } }
    : null
  const mm = new MemoryManager(db, {
    workerConfig,
    embeddingModel: env.EMBEDDING_MODEL,
    apiKey: env.OPENROUTER_API_KEY,
  })

  const observations = await mm.getActiveObservations(session.conversation_id)
  return c.json({ observations })
})
