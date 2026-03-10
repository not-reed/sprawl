import { serve } from "@hono/node-server";
import { env } from "./env.js";
import { createDb } from "@repo/db";
import type { Database } from "./db/schema.js";
import { runMigrations } from "./db/migrate.js";
import { createApp } from "./server.js";

async function main() {
  console.log(`Loom starting`);
  console.log(`Model: ${env.OPENROUTER_MODEL}`);
  console.log(`Database: ${env.DATABASE_URL}`);

  await runMigrations(env.DATABASE_URL);

  const { db } = createDb<Database>(env.DATABASE_URL);
  const app = createApp(db);

  console.log(`Loom running at http://localhost:${env.PORT}`);

  serve({
    fetch: app.fetch,
    port: env.PORT,
  });

  const shutdown = async () => {
    console.log("Shutting down");
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
