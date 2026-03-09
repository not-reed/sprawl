---
title: DB Package
description: Shared Kysely database factory and migrations
---

# @repo/db

Shared database package providing a Kysely instance backed by Node.js built-in `node:sqlite` (`DatabaseSync`). Used by all JS apps in the monorepo.

## Exports

- **`createDb<T>(path)`** -- Creates a Kysely instance with WAL mode, busy timeout, and foreign keys enabled
- **`runMigrations(path, migrations)`** -- File-based migration runner

## Custom Dialect

Implements three classes to bridge `node:sqlite` to Kysely:

- **`NodeSqliteDialect`** -- Creates driver, query compiler, adapter, introspector
- **`NodeSqliteDriver`** -- Connection lifecycle and transactions
- **`NodeSqliteConnection`** -- Query execution (detects SELECT vs write statements)

## Pragmas

```sql
PRAGMA journal_mode = WAL    -- Concurrent read/write
PRAGMA busy_timeout = 5000   -- Wait on lock contention
PRAGMA foreign_keys = ON     -- Enforce FK constraints
```

## Why node:sqlite?

Avoids `better-sqlite3` and its native C++ compilation requirement. Uses the Node.js built-in SQLite module available since Node 22.
