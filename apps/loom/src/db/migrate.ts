import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDb } from "@repo/db";
import { runMigrations as runMigrationsGeneric } from "@repo/db/migrate";
import type { Database } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(databaseUrl: string) {
  const { db } = createDb<Database>(databaseUrl);
  await runMigrationsGeneric(db, join(__dirname, "migrations"));
  await db.destroy();
}
