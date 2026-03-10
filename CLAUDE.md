# Sprawl

Monorepo for personal AI tools. Five apps, two shared packages, one memory pipeline. Everything converges in SQLite.

## Monorepo Layout

```
sprawl/
├── apps/
│   ├── construct/       # AI braindump companion (Telegram + CLI + scheduler)
│   ├── cortex/          # Crypto market intelligence daemon
│   ├── synapse/         # Paper trading daemon
│   ├── deck/            # Memory graph explorer (Hono + React)
│   └── optic/           # Terminal trading dashboard (Rust/Ratatui)
├── packages/
│   ├── cairn/           # Memory substrate (observer/reflector, embeddings, graph)
│   └── db/              # Shared Kysely database factory + migrations
├── Justfile             # Task runner (use `just` not npm scripts)
├── pnpm-workspace.yaml
└── data/                # Dev runtime data (DBs, extensions, logs)
```

## Architecture

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Construct   │  │   Cortex    │  │   Synapse   │  │    Deck     │  │    Optic    │
│  (agent)     │  │  (ingest)   │  │  (trading)  │  │  (web UI)   │  │  (TUI)      │
└──────┬───────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                 │                │                │                │
       └─────────────────┼────────────────┘                │                │
                         │                                 │                │
            ┌────────────▼────────────┐                    │                │
            │      @repo/cairn        │                    │                │
            │  observe → reflect →    │                    │                │
            │  promote → graph        │                    │                │
            ╰────────────┬────────────╯                    │                │
                         │                                 │                │
            ┌────────────▼─────────────────────────────────▼───┐           │
            │               @repo/db                            │           │
            │          kysely + migrations                      │           │
            └──────────────────┬────────────────────────────────┘           │
                               │                                            │
            ┌──────────────────▼────────────────────────────────────────────▼──┐
            │                            SQLITE                                │
            └──────────────────────────────────────────────────────────────────┘
```

Construct, Cortex, and Deck use Cairn for memory. Synapse reads Cortex's DB directly. Optic reads both Cortex and Synapse DBs via rusqlite.

## Tech Stack

- **Runtime**: Node.js + tsx (TS apps), Rust (Optic TUI)
- **Package manager**: pnpm (workspace monorepo)
- **Task runner**: Just (`Justfile`)
- **Agent**: @mariozechner/pi-agent-core
- **LLM**: OpenRouter (OpenAI-compatible)
- **Database**: SQLite via node:sqlite + Kysely (JS), rusqlite (Rust)
- **Memory**: @repo/cairn (observer/reflector, FTS5, embeddings, graph)
- **Telegram**: Grammy (long polling)
- **CLI**: Citty
- **Scheduler**: Croner
- **Web**: Hono + React + D3-force (Deck)
- **TUI**: Ratatui + Crossterm (Optic)
- **Linting**: oxlint (`.oxlintrc.json`)
- **Formatting**: oxfmt
- **Pre-commit**: lefthook (`lefthook.yml`)
- **CI**: GitHub Actions (`.github/workflows/ci.yml`)
- **Testing**: Vitest
- **Logging**: Logtape
- **Schemas**: TypeBox (tool parameters), Zod (env validation)
- **Dynamic tool loading**: jiti (TypeScript without compile step)

## Commands (Justfile)

```bash
just                     # List all commands

# Quality gates
just check               # Run ALL checks: typecheck + lint + fmt-check + test
just typecheck           # Typecheck all packages
just lint                # Run oxlint
just lint-fix            # Auto-fix lint issues
just fmt                 # Format all files with oxfmt
just fmt-check           # Check formatting (no writes)

# Test
just test                # Run all tests (pnpm -r run test)
just test-construct      # Construct tests only
just test-cairn          # Cairn tests only
just test-synapse        # Synapse tests only
just test-ai             # AI integration tests (requires OPENROUTER_API_KEY)

# Apps
just dev                 # Construct dev mode (file watching)
just start <instance>    # Start a named construct instance
just cli [instance] [args] # Construct CLI
just cortex-dev          # Cortex dev mode
just cortex-start        # Cortex production
just synapse-dev         # Synapse dev mode
just synapse-start       # Synapse production
just synapse-status      # Print portfolio summary
just deck-dev <instance> # Deck dev mode

# DB
just db-migrate [inst]   # Run DB migrations
```

## Pre-commit Hooks (lefthook)

Runs in parallel on every commit:

1. `just fmt-check` -- formatting
2. `just lint` -- oxlint
3. `just typecheck` -- tsc

CI (`.github/workflows/ci.yml`) runs the same checks plus `pnpm -r run test`.

## Conventions

### Error Classes

Every app/package defines domain-specific errors in `src/errors.ts`. Pattern:

```typescript
export class MemoryError extends Error {
  name = "MemoryError" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
```

Always use `{ cause: originalError }` when wrapping. Errors by package:

- **@repo/db**: `DatabaseError`, `MigrationError`
- **@repo/cairn**: `MemoryError`, `EmbeddingError`, `GraphError`
- **construct**: `ToolError`, `ExtensionError`, `AgentError`, `ConfigError`
- **cortex**: `IngestError`, `AnalyzerError`
- **synapse**: `ExecutionError`, `RiskError`

### Testing

- **Framework**: Vitest, configs at `vitest.config.ts` per package
- **Fixtures**: Factory functions in `src/__tests__/fixtures.ts` using the spread pattern:
  ```typescript
  createTestSignal({ confidence: 0.9 }); // override only what matters
  ```
- **Cairn test DB**: `packages/cairn/src/__tests__/test-db.ts` provides `setupCairnTestDb()` -- creates in-memory SQLite with all cairn tables. Use for any test touching cairn queries.
- **Construct test DB**: `apps/construct/src/__tests__/fixtures.ts` has `setupDb()` which runs construct migrations against `:memory:`
- No mocking LLM calls in unit tests -- use synthetic embeddings (16-d vectors with orthogonal topic clusters)

### Migrations

Additive only -- never drop tables or columns. Each app has its own `src/db/migrations/` directory. Pattern:

```typescript
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE observations ADD COLUMN expires_at TEXT`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Additive only -- no-op
}
```

Numbering: `NNN-description.ts` (e.g. `010-observation-expires-at.ts`).

### Tools (Construct)

Factory function pattern -- each tool file exports `createXTool(db, ...)`:

```typescript
const Params = Type.Object({ content: Type.String({ description: "..." }) });

export function createMemoryStoreTool(db: Kysely<Database>, apiKey?: string) {
  return {
    name: "memory_store",
    description: "...",
    parameters: Params,
    execute: async (_toolCallId: string, args: Static<typeof Params>) => {
      // ...
      return { output: "Stored.", details: { id: memory.id } };
    },
  };
}
```

Tool packs are semantically selected per message via embeddings (core pack always loads).

### Environment Variables

Env files: `.env.<app>` in repo root (e.g. `.env.construct`, `.env.cortex`). Examples: `.env.<app>.example`. Justfile passes via `node --env-file=.env.<app>`. All SQLite databases go in `./data/`.

## Optic (Rust)

```
apps/optic/src/
├── main.rs   # CLI args, DB connections, terminal setup, event loop
├── db.rs     # CortexDb + SynapseDb (rusqlite, read-only)
└── ui.rs     # Ratatui rendering: Market view + Trading view
```

Two view modes: **Market** (prices, chart, news, signals, graph) and **Trading** (positions, trades, signal log, risk events). Different toolchain -- `cargo build`, not covered by `just check`.

## Extensions (Construct)

Location: `EXTENSIONS_DIR` env var (defaults to `./data` in dev).

```
$EXTENSIONS_DIR/
├── SOUL.md       # Personality (injected into system prompt)
├── IDENTITY.md   # Agent metadata: name, type, pronouns
├── USER.md       # Human context: name, location, preferences
├── skills/       # Markdown skills (YAML frontmatter + body)
└── tools/        # TypeScript tools (hot-loaded via jiti)
```
