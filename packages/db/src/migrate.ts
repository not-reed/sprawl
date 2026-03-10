import { FileMigrationProvider, Migrator, type Kysely } from "kysely";
import { MigrationError } from "./errors.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * Generic migration runner. Consumers provide the db instance and migration folder path.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely invariance
export async function runMigrations(db: Kysely<any>, migrationFolder: string) {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path: { join },
      migrationFolder,
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === "Success") {
      console.log(`Migration "${it.migrationName}" was executed successfully`);
    } else if (it.status === "Error") {
      console.error(`Failed to execute migration "${it.migrationName}"`);
    }
  });

  if (error) {
    console.error("Failed to migrate", error);
    throw new MigrationError("Migration failed", { cause: error });
  }
}
