import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDb } from "@repo/db";
import { runMigrations as runMigrationsGeneric } from "@repo/db/migrate";
import { env } from "../env.js";
import type { Database } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(databaseUrl?: string) {
  const { db } = createDb<Database>(databaseUrl ?? env.DATABASE_URL);

  await runMigrationsGeneric(db, join(__dirname, "migrations"));

  await db.destroy();
}

// Run directly: tsx src/db/migrate.ts
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.ts") || process.argv[1].endsWith("migrate.js"));

if (isDirectRun) {
  runMigrations();
}
