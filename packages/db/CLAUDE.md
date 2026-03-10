# @repo/db

Shared Kysely database factory and custom `node:sqlite` dialect. Used by all JS apps.

## Key Files

- `src/index.ts` -- `createDb<T>(url)`: Kysely instance + underlying `DatabaseSync` handle
- `src/errors.ts` -- `DatabaseError`, `MigrationError`

## API

```typescript
import { createDb } from "@repo/db";
import type { MyDatabase } from "./schema.js";

const { db, sqlite } = createDb<MyDatabase>("./data/my.db");
```

`createDb` configures:

- WAL mode (`PRAGMA journal_mode = WAL`)
- 5s busy timeout (`PRAGMA busy_timeout = 5000`)
- Foreign keys ON

Uses `node:sqlite` (`DatabaseSync`) -- no native C++ deps (no better-sqlite3).

## Custom Dialect

The file implements a full Kysely dialect for `node:sqlite`:

- `NodeSqliteDialect` -- dialect entry point
- `NodeSqliteDriver` -- transaction management
- `NodeSqliteConnection` -- query execution (detects SELECT vs INSERT/UPDATE/DELETE)

The SELECT detection in `executeQuery` handles `SELECT`, `PRAGMA`, and `WITH` (non-mutating) as read queries.

## Error Classes

- `DatabaseError` -- connection/query/dialect failures
- `MigrationError` -- migration execution failures

## Notes

- Each app owns its own migrations (in `src/db/migrations/`). This package provides no migration runner -- apps implement their own using `Kysely`'s `sql` template tag.
- `:memory:` is supported as a URL for test databases.
