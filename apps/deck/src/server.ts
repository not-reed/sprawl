import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { serve } from '@hono/node-server'
import { env } from './env.js'
import { createDb } from '@repo/db'
import { memoriesRoutes } from './routes/memories.js'
import { graphRoutes } from './routes/graph.js'
import { observationsRoutes } from './routes/observations.js'
import { statsRoutes } from './routes/stats.js'
import type { Kysely } from 'kysely'
import type { CairnDatabase } from '@repo/cairn'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Env = {
  Variables: {
    db: Kysely<CairnDatabase>
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const { db } = createDb<CairnDatabase>(env.DATABASE_URL)

const app = new Hono<Env>()

app.use(cors())

// Inject db into context
app.use('*', async (c, next) => {
  c.set('db', db)
  await next()
})

// API routes
app.route('/api/memories', memoriesRoutes)
app.route('/api/graph', graphRoutes)
app.route('/api/observations', observationsRoutes)
app.route('/api/stats', statsRoutes)

// Serve built frontend (skip in dev — use Vite dev server instead)
if (process.env.NODE_ENV !== 'development') {
  app.use('*', serveStatic({ root: join(__dirname, '..', 'web', 'dist') }))
  app.use('*', serveStatic({ root: join(__dirname, '..', 'web', 'dist'), path: '/index.html' }))
}

console.log(`Memory Explorer running at http://localhost:${env.PORT}`)

serve({
  fetch: app.fetch,
  port: env.PORT,
})
