import { FileMigrationProvider, Migrator } from 'kysely'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createDb } from './index.js'
import { env } from '../env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function runMigrations(databaseUrl?: string) {
  const { db } = createDb(databaseUrl ?? env.DATABASE_URL)

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path: { join },
      migrationFolder: join(__dirname, 'migrations'),
    }),
  })

  const { error, results } = await migrator.migrateToLatest()

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`Migration "${it.migrationName}" was executed successfully`)
    } else if (it.status === 'Error') {
      console.error(`Failed to execute migration "${it.migrationName}"`)
    }
  })

  if (error) {
    console.error('Failed to migrate', error)
    process.exit(1)
  }

  await db.destroy()
}

// Run directly: tsx src/db/migrate.ts
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('migrate.ts') ||
    process.argv[1].endsWith('migrate.js'))

if (isDirectRun) {
  runMigrations()
}
