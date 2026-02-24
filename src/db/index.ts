import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  Kysely,
  type DatabaseConnection,
  type Driver,
  type CompiledQuery,
  type QueryResult,
  type Dialect,
  type DialectAdapterBase,
  type QueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely'

import type { Database as DatabaseSchema } from './schema.js'

/**
 * Kysely dialect adapter for Node.js built-in node:sqlite (DatabaseSync).
 * This avoids the need for better-sqlite3 and its native C++ compilation.
 */
class NodeSqliteDriver implements Driver {
  #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new NodeSqliteConnection(this.#db)
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery({ sql: 'BEGIN', parameters: [], query: { kind: 'RawNode' } as any })
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery({ sql: 'COMMIT', parameters: [], query: { kind: 'RawNode' } as any })
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery({ sql: 'ROLLBACK', parameters: [], query: { kind: 'RawNode' } as any })
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {
    this.#db.close()
  }
}

class NodeSqliteConnection implements DatabaseConnection {
  #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery
    const stmt = this.#db.prepare(sql)

    // Detect if this is a read or write query
    const trimmed = sql.trimStart().toUpperCase()
    const isSelect =
      trimmed.startsWith('SELECT') ||
      trimmed.startsWith('PRAGMA') ||
      trimmed.startsWith('WITH')

    const params = parameters as SQLInputValue[]

    if (isSelect) {
      const rows = stmt.all(...params) as R[]
      return { rows }
    }

    const result = stmt.run(...params)
    return {
      rows: [],
      numAffectedRows: BigInt(result.changes),
      insertId: result.lastInsertRowid !== undefined
        ? BigInt(result.lastInsertRowid)
        : undefined,
    }
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('node:sqlite does not support streaming')
  }
}

class NodeSqliteDialect implements Dialect {
  #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  createDriver(): Driver {
    return new NodeSqliteDriver(this.#db)
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler()
  }

  createAdapter(): DialectAdapterBase {
    return new SqliteAdapter()
  }

  createIntrospector(db: Kysely<unknown>) {
    return new SqliteIntrospector(db)
  }
}

export function createDb(url: string) {
  const sqlite = new DatabaseSync(url)

  // WAL mode for concurrent read/write
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA busy_timeout = 5000')
  sqlite.exec('PRAGMA foreign_keys = ON')

  const db = new Kysely<DatabaseSchema>({
    dialect: new NodeSqliteDialect(sqlite),
  })

  return { db, sqlite }
}
