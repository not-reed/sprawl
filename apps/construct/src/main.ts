import { env } from "./env.js";
import { setupLogging, log } from "./logger.js";
import { createDb } from "@repo/db";
import type { Database } from "./db/schema.js";
import { runMigrations } from "./db/migrate.js";
import { createBot } from "./telegram/bot.js";
import { startScheduler, stopScheduler } from "./scheduler/index.js";
import { initPackEmbeddings } from "./tools/packs.js";
import { syncEnvSecrets } from "./extensions/secrets.js";
import { initExtensions } from "./extensions/index.js";

async function main() {
  await setupLogging(env.LOG_LEVEL, env.LOG_FILE);

  log.info`Starting Construct`;
  log.info`Model: ${env.OPENROUTER_MODEL}`;
  log.info`Database: ${env.DATABASE_URL}`;
  log.info`Timezone: ${env.TIMEZONE}`;

  // Run migrations
  await runMigrations(env.DATABASE_URL);

  // Create database connection
  const { db } = createDb<Database>(env.DATABASE_URL);

  // Sync EXT_* env vars into secrets table
  await syncEnvSecrets(db);

  // Initialize extensions (SOUL.md, skills, dynamic tools + their embeddings)
  await initExtensions(env.EXTENSIONS_DIR, env.OPENROUTER_API_KEY, db, env.EMBEDDING_MODEL);

  // Pre-compute tool pack embeddings for semantic selection
  await initPackEmbeddings(env.OPENROUTER_API_KEY, env.EMBEDDING_MODEL);

  // Create Telegram bot
  const bot = createBot(db);

  // Start scheduler
  await startScheduler(db, bot, env.TIMEZONE);

  // Start Telegram long polling
  log.info`Construct is running`;
  bot.start({ allowed_updates: ["message", "message_reaction", "callback_query"] });

  // Graceful shutdown
  const shutdown = async () => {
    log.info`Shutting down`;
    stopScheduler();
    bot.stop();
    await db.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
