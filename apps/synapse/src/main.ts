import { env } from './env.js'
import { createDb } from '@repo/db'
import type { Database } from './db/schema.js'
import { runMigrations } from './db/migrate.js'
import { CortexReader } from './cortex/reader.js'
import { PaperExecutor } from './engine/executor.js'
import { startLoop, stopLoop } from './engine/loop.js'
import { initPortfolioState, getPortfolioState } from './db/queries.js'

function log(msg: string) {
  console.log(`[synapse] ${msg}`)
}

async function main() {
  log(`Synapse DB: ${env.DATABASE_URL}`)
  log(`Cortex DB: ${env.CORTEX_DATABASE_URL}`)
  log(`Initial balance: $${env.INITIAL_BALANCE_USD}`)

  // Run migrations
  await runMigrations(env.DATABASE_URL)

  // Create connections
  const { db } = createDb<Database>(env.DATABASE_URL)
  const cortex = new CortexReader(env.CORTEX_DATABASE_URL)

  // Initialize portfolio if first run
  await initPortfolioState(db, env.INITIAL_BALANCE_USD)

  const state = await getPortfolioState(db)
  if (state) {
    log(`Portfolio: $${state.total_value_usd.toFixed(2)} (cash: $${state.cash_usd.toFixed(2)}, drawdown: ${state.drawdown_pct.toFixed(1)}%${state.halted ? ', HALTED' : ''})`)
  }

  // Create paper executor
  const executor = new PaperExecutor(cortex, {
    slippageBps: env.SLIPPAGE_BPS,
    gasUsd: env.SIMULATED_GAS_USD,
  })

  // Start loop
  startLoop({ db, cortex, executor, env, log })
  log('Daemon running. Press Ctrl+C to stop.')

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...')
    stopLoop()
    await cortex.destroy()
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
