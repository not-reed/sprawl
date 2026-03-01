import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Kysely } from 'kysely'
import { createDb } from '@repo/db'
import type { Database } from '../../db/schema.js'
import * as migration001 from '../../db/migrations/001-initial.js'
import * as migration002 from '../../db/migrations/002-fts5-and-embeddings.js'
import * as migration003 from '../../db/migrations/003-secrets.js'
import {
  syncEnvSecrets,
  getSecret,
  setSecret,
  listSecretKeys,
  deleteSecret,
  buildSecretsMap,
} from '../secrets.js'

describe('secrets', () => {
  let db: Kysely<Database>

  beforeEach(async () => {
    const result = createDb<Database>(':memory:')
    db = result.db
    await migration001.up(db as Kysely<unknown>)
    await migration002.up(db as Kysely<unknown>)
    await migration003.up(db as Kysely<unknown>)
  })

  afterEach(async () => {
    await db.destroy()
  })

  describe('setSecret / getSecret', () => {
    it('stores and retrieves a secret', async () => {
      await setSecret(db, 'MY_KEY', 'my_value')
      const value = await getSecret(db, 'MY_KEY')
      expect(value).toBe('my_value')
    })

    it('returns null for missing secret', async () => {
      const value = await getSecret(db, 'NONEXISTENT')
      expect(value).toBeNull()
    })

    it('upserts on duplicate key', async () => {
      await setSecret(db, 'MY_KEY', 'v1')
      await setSecret(db, 'MY_KEY', 'v2')
      const value = await getSecret(db, 'MY_KEY')
      expect(value).toBe('v2')
    })
  })

  describe('listSecretKeys', () => {
    it('lists keys and sources', async () => {
      await setSecret(db, 'KEY_A', 'a', 'agent')
      await setSecret(db, 'KEY_B', 'b', 'env')
      const keys = await listSecretKeys(db)
      expect(keys).toEqual([
        { key: 'KEY_A', source: 'agent' },
        { key: 'KEY_B', source: 'env' },
      ])
    })

    it('returns empty for no secrets', async () => {
      const keys = await listSecretKeys(db)
      expect(keys).toEqual([])
    })
  })

  describe('deleteSecret', () => {
    it('deletes an existing secret', async () => {
      await setSecret(db, 'TO_DELETE', 'val')
      const deleted = await deleteSecret(db, 'TO_DELETE')
      expect(deleted).toBe(true)
      const value = await getSecret(db, 'TO_DELETE')
      expect(value).toBeNull()
    })

    it('returns false for nonexistent key', async () => {
      const deleted = await deleteSecret(db, 'NOPE')
      expect(deleted).toBe(false)
    })
  })

  describe('syncEnvSecrets', () => {
    it('syncs EXT_* env vars', async () => {
      process.env.EXT_TEST_KEY = 'test_val'
      process.env.EXT_ANOTHER = 'another_val'

      const count = await syncEnvSecrets(db)
      expect(count).toBe(2)

      const val = await getSecret(db, 'TEST_KEY')
      expect(val).toBe('test_val')
      const val2 = await getSecret(db, 'ANOTHER')
      expect(val2).toBe('another_val')

      // Cleanup
      delete process.env.EXT_TEST_KEY
      delete process.env.EXT_ANOTHER
    })

    it('env source overwrites agent source on sync', async () => {
      await setSecret(db, 'SHARED', 'agent_value', 'agent')

      process.env.EXT_SHARED = 'env_value'
      await syncEnvSecrets(db)

      const val = await getSecret(db, 'SHARED')
      expect(val).toBe('env_value')

      delete process.env.EXT_SHARED
    })
  })

  describe('buildSecretsMap', () => {
    it('builds a Map from all secrets', async () => {
      await setSecret(db, 'A', 'va')
      await setSecret(db, 'B', 'vb')
      const map = await buildSecretsMap(db)
      expect(map.get('A')).toBe('va')
      expect(map.get('B')).toBe('vb')
      expect(map.size).toBe(2)
    })
  })
})
