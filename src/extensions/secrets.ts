import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../db/schema.js'
import { toolLog } from '../logger.js'

type DB = Kysely<Database>

/**
 * Sync all EXT_* environment variables into the secrets table.
 * .env values always win on restart (source='env' overwrite).
 */
export async function syncEnvSecrets(db: DB): Promise<number> {
  const extVars = Object.entries(process.env).filter(
    ([key]) => key.startsWith('EXT_'),
  )

  let synced = 0
  for (const [key, value] of extVars) {
    if (!value) continue
    // Strip the EXT_ prefix for the secret key name
    const secretKey = key.slice(4)
    await db
      .insertInto('secrets')
      .values({
        key: secretKey,
        value,
        source: 'env',
      })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          value,
          source: 'env',
          updated_at: sql<string>`datetime('now')`,
        }),
      )
      .execute()
    synced++
  }

  if (synced > 0) {
    toolLog.info`Synced ${synced} env secrets to database`
  }
  return synced
}

/** Get a secret value by key. Returns null if not found. */
export async function getSecret(db: DB, key: string): Promise<string | null> {
  const row = await db
    .selectFrom('secrets')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst()
  return row?.value ?? null
}

/** Store or update a secret. */
export async function setSecret(
  db: DB,
  key: string,
  value: string,
  source: 'agent' | 'env' = 'agent',
): Promise<void> {
  await db
    .insertInto('secrets')
    .values({ key, value, source })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({
        value,
        source,
        updated_at: sql<string>`datetime('now')`,
      }),
    )
    .execute()
}

/** List all secret key names (never exposes values). */
export async function listSecretKeys(db: DB): Promise<Array<{ key: string; source: string }>> {
  return db
    .selectFrom('secrets')
    .select(['key', 'source'])
    .orderBy('key')
    .execute()
}

/** Delete a secret by key. Returns true if deleted. */
export async function deleteSecret(db: DB, key: string): Promise<boolean> {
  const result = await db
    .deleteFrom('secrets')
    .where('key', '=', key)
    .executeTakeFirst()
  return (result.numDeletedRows ?? 0n) > 0n
}

/** Build a secrets Map for use in dynamic tool contexts. */
export async function buildSecretsMap(db: DB): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom('secrets')
    .select(['key', 'value'])
    .execute()
  return new Map(rows.map((r) => [r.key, r.value]))
}
