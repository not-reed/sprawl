import { FileMigrationProvider, Migrator } from 'kysely'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createDb } from '../src/db/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function runMigrations(databaseUrl: string) {
  const { db } = createDb(databaseUrl)

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path: { join },
      migrationFolder: join(__dirname, '..', 'src', 'db', 'migrations'),
    }),
  })

  const { error, results } = await migrator.migrateToLatest()

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`Migration "${it.migrationName}" executed successfully`)
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
