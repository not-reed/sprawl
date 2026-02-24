import { createDb } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { setupLogging, log } from '../logger.js'
import { env } from '../env.js'
import { createBot } from './bot.js'

async function main() {
  await setupLogging(env.LOG_LEVEL)
  log.info`Starting Nullclaw Telegram bot`

  await runMigrations(env.DATABASE_URL)

  const { db } = createDb(env.DATABASE_URL)
  const bot = createBot(db)

  log.info`Telegram bot is running (long polling)`
  bot.start()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
