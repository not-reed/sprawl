import { env } from './env.js'
import { setupLogging, log } from './logger.js'
import { createDb } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { createBot } from './telegram/bot.js'
import { startScheduler, stopScheduler } from './scheduler/index.js'

async function main() {
  await setupLogging(env.LOG_LEVEL)

  log.info`Starting Nullclaw`
  log.info`Model: ${env.OPENROUTER_MODEL}`
  log.info`Database: ${env.DATABASE_URL}`
  log.info`Timezone: ${env.TIMEZONE}`

  // Run migrations
  await runMigrations(env.DATABASE_URL)

  // Create database connection
  const { db } = createDb(env.DATABASE_URL)

  // Create Telegram bot
  const bot = createBot(db)

  // Start scheduler
  await startScheduler(db, bot)

  // Start Telegram long polling
  log.info`Nullclaw is running`
  bot.start()

  // Graceful shutdown
  const shutdown = async () => {
    log.info`Shutting down`
    stopScheduler()
    bot.stop()
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
