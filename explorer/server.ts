import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { serve } from '@hono/node-server'
import { env } from './env.js'
import { createDb } from '../src/db/index.js'
import { runMigrations } from './migrate.js'
import { memoriesRoutes } from './routes/memories.js'
import { graphRoutes } from './routes/graph.js'
import { observationsRoutes } from './routes/observations.js'
import { statsRoutes } from './routes/stats.js'
import type { Kysely } from 'kysely'
import type { Database } from '../src/db/schema.js'

export type Env = {
  Variables: {
    db: Kysely<Database>
  }
}

// Run migrations before starting
await runMigrations(env.DATABASE_URL)

const { db } = createDb(env.DATABASE_URL)

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
  app.use('*', serveStatic({ root: './explorer/web/dist' }))
  app.use('*', serveStatic({ root: './explorer/web/dist', path: '/index.html' }))
}

console.log(`Memory Explorer running at http://localhost:${env.PORT}`)

serve({
  fetch: app.fetch,
  port: env.PORT,
})
