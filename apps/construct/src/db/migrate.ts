import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDb } from "@repo/db";
import { runMigrations as runMigrationsGeneric } from "@repo/db/migrate";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(databaseUrl?: string): Promise<void>;
export async function runMigrations(db: Kysely<Database>): Promise<void>;
export async function runMigrations(databaseUrlOrDb?: string | Kysely<Database>): Promise<void> {
  // If it's a Kysely instance, use it directly
  if (databaseUrlOrDb && typeof databaseUrlOrDb === "object" && "selectFrom" in databaseUrlOrDb) {
    await runMigrationsGeneric(databaseUrlOrDb as Kysely<unknown>, join(__dirname, "migrations"));
    return;
  }

  // Otherwise, create a new DB connection
  const url =
    (databaseUrlOrDb as string | undefined) ?? (await import("../env.js")).env.DATABASE_URL;
  const { db } = createDb<Database>(url);

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
