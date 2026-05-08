import { env } from "./env.js";
import { setupLogging, log } from "./logger.js";
import { initTracing } from "./tracing.js";
import { createDb } from "@repo/db";
import type { Database } from "./db/schema.js";
import { runMigrations } from "./db/migrate.js";
import { createBot } from "./telegram/bot.js";
import { startScheduler, stopScheduler } from "./scheduler/index.js";
import { syncEnvSecrets } from "./extensions/secrets.js";
import { initExtensions } from "./extensions/index.js";
import {
  ConstructMemoryManager,
  CONSTRUCT_OBSERVER_PROMPT,
  CONSTRUCT_REFLECTOR_PROMPT,
} from "./memory.js";
import { PipelineQueue } from "@repo/cairn";

async function main() {
  await setupLogging(env.LOG_LEVEL, env.LOG_FILE);
  initTracing(env.LAMINAR_API_KEY, env.LAMINAR_BASE_URL);

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

  // Initialize extensions (SOUL.md, skills, dynamic tools + cached embeddings)
  await initExtensions(
    env.EXTENSIONS_DIR,
    env.OPENROUTER_API_KEY,
    db,
    env.EMBEDDING_MODEL,
    env.MEMORY_WORKER_MODEL || env.OPENROUTER_MODEL,
  );

  // Create memory manager for the pipeline queue (shared instance)
  const memoryManager = new ConstructMemoryManager(db, {
    workerConfig: env.MEMORY_WORKER_MODEL
      ? {
          apiKey: env.OPENROUTER_API_KEY,
          model: env.MEMORY_WORKER_MODEL,
          baseUrl: env.OPENROUTER_BASE_URL,
          extraBody: { reasoning: { max_tokens: 1 } },
        }
      : null,
    embeddingModel: env.EMBEDDING_MODEL,
    apiKey: env.OPENROUTER_API_KEY,
    observerPrompt: CONSTRUCT_OBSERVER_PROMPT,
    reflectorPrompt: CONSTRUCT_REFLECTOR_PROMPT,
  });

  // Create and start pipeline queue for crash-recoverable post-turn processing
  const pipelineQueue = new PipelineQueue(db, memoryManager);
  await pipelineQueue.start();
  log.info`Pipeline queue started`;

  // Create Telegram bot with queue reference
  const bot = createBot(db, pipelineQueue);

  // Start scheduler
  await startScheduler(db, bot, env.TIMEZONE);

  // Start Telegram long polling
  log.info`Construct is running`;
  bot.start({ allowed_updates: ["message", "message_reaction", "callback_query"] });

  // Graceful shutdown — idempotent, with hard timeout + force-exit on repeat signal
  let shuttingDown = false;
  const SHUTDOWN_TIMEOUT_MS = 3000;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      log.warning`Received ${signal} during shutdown — forcing exit`;
      process.exit(1);
    }
    shuttingDown = true;
    log.info`Shutting down (${signal})`;

    const hardExit = setTimeout(() => {
      log.warning`Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`;
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    hardExit.unref();

    try {
      pipelineQueue.stop();
      stopScheduler();
      await bot.stop();
      await db.destroy();
    } catch (err) {
      log.error`Error during shutdown: ${err}`;
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
