import { env } from './env.js'
import { createDb } from '@repo/db'
import { MemoryManager } from '@repo/cairn'
import type { Database } from './db/schema.js'
import { runMigrations } from './db/migrate.js'
import { fetchTokenInfo } from './ingest/prices.js'
import { upsertTrackedToken } from './db/queries.js'
import { startLoop, stopLoop, ingestPrices } from './pipeline/loop.js'
import { runBackfill, type BackfillScope } from './pipeline/backfill.js'

function log(msg: string) {
  console.log(`[cortex] ${msg}`)
}

async function main() {
  // Parse --backfill, --backfill-news, --backfill-prices flags
  const args = process.argv
  let backfillDays: number | null = null
  let backfillScope: BackfillScope = 'all'

  for (const flag of ['--backfill-news', '--backfill-prices', '--backfill']) {
    const idx = args.indexOf(flag)
    if (idx !== -1) {
      const nextArg = args[idx + 1]
      backfillDays = parseInt(nextArg ?? '30', 10)
      if (flag === '--backfill-news') backfillScope = 'news'
      else if (flag === '--backfill-prices') backfillScope = 'prices'
      break
    }
  }

  log(`Database: ${env.DATABASE_URL}`)
  log(`Tokens: ${env.TRACKED_TOKENS.join(', ')}`)

  // Run migrations
  await runMigrations(env.DATABASE_URL)

  // Create database connection
  const { db } = createDb<Database>(env.DATABASE_URL)

  // Create MemoryManager
  const memory = new MemoryManager(db as any, {
    workerConfig: {
      apiKey: env.OPENROUTER_API_KEY,
      model: env.MEMORY_WORKER_MODEL,
    },
    embeddingModel: env.EMBEDDING_MODEL,
    apiKey: env.OPENROUTER_API_KEY,
    logger: {
      info: (msg) => log(`[cairn] ${msg}`),
      warning: (msg) => log(`[cairn:warn] ${msg}`),
      error: (msg) => log(`[cairn:error] ${msg}`),
      debug: () => {},
    },
  })

  // Seed tracked tokens
  log('Seeding tracked tokens...')
  const tokenInfos = await fetchTokenInfo(env.TRACKED_TOKENS)
  for (const info of tokenInfos) {
    await upsertTrackedToken(db as any, info)
    log(`  ${info.symbol} (${info.name})`)
  }

  // Brief pause after seeding (both hit CoinGecko)
  await new Promise((r) => setTimeout(r, 3000))

  // Backfill mode
  if (backfillDays) {
    await runBackfill(db as any, memory, backfillDays, log, backfillScope)

    // Exit after backfill unless --daemon flag
    if (!process.argv.includes('--daemon')) {
      await db.destroy()
      process.exit(0)
    }
  }

  // Initial price fetch (non-fatal — cron will retry)
  log('Fetching initial prices...')
  try {
    await ingestPrices(db as any, memory, log)
  } catch (err) {
    log(`Initial price fetch failed (will retry on next cycle): ${err}`)
  }

  // Start pipeline loop (headless daemon)
  startLoop({ db: db as any, memory, log })
  log('Daemon running. Press Ctrl+C to stop.')

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...')
    stopLoop()
    await db.destroy()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
