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
- **Scheduler**: Croner (Construct + Cortex + Synapse)
- **Web**: Hono + React + D3-force (Deck)
- **TUI**: Ratatui + Crossterm (Optic)
- **Web tools**: Tavily (search), fetch + parsing (read)
- **Data sources**: CoinGecko (prices), CryptoPanic + CryptoCompare (news)
- **Logging**: Logtape
- **Testing**: Vitest
- **Dynamic tool loading**: jiti (TypeScript without compile step)
- **Schemas**: TypeBox (tool parameters), Zod (env validation)

## Key Conventions

- **Tools** follow the `{ name, description, parameters, execute }` pattern with TypeBox schemas
- **Migrations** are additive only — never drop tables or columns
- **Self-aware tools** are scoped to `src/`, `cli/`, and `extensions/` — never system files
- **Self-deploy** requires passing tests first and is rate-limited to 3/hour
- **Extensions** are user/agent-authored skills (Markdown) and tools (TypeScript) loaded from `EXTENSIONS_DIR`
- **Tool packs** are semantically selected per message via embeddings (core pack always loads)

## Commands (Justfile)

```bash
just                     # List all commands

# Construct
just dev                 # Construct dev mode (file watching)
just start <instance>    # Start a named construct instance
just cli [instance] [args] # Construct CLI

# Cortex
just cortex-dev          # Cortex dev mode (file watching)
just cortex-start        # Cortex production
just cortex-backfill [days] # Backfill historical data (default: 30)
just cortex-backfill-news [days]   # Backfill news only
just cortex-backfill-prices [days] # Backfill prices only

# Synapse
just synapse-dev         # Synapse dev mode (file watching)
just synapse-start       # Synapse production
just synapse-status      # Print portfolio summary

# Deck
just deck-dev <instance> # Deck dev mode (memory graph explorer)

# Optic
just optic [db] [synapse] # Optic TUI (reads cortex + synapse DBs)
just optic-build         # Build optic release binary

# Test / Typecheck
just test                # Run all tests
just test-construct      # Construct tests
just test-cairn          # Cairn tests
just test-synapse        # Synapse tests
just test-ai             # AI integration tests
just typecheck           # Typecheck all packages

# DB
just db-migrate [inst]   # Run DB migrations
```

## Construct Directory Structure

```
apps/construct/src/
├── agent.ts             # Agent factory, processMessage(), tool registration
├── system-prompt.ts     # System prompt + identity file injection
├── main.ts              # Boot (migrations, DB, extensions, scheduler, Telegram)
├── env.ts               # Zod-validated environment variables
├── logger.ts            # Logtape logging
├── cli/
│   └── index.ts         # Citty CLI (REPL, one-shot, tool invocation)
├── db/
│   ├── schema.ts        # Table types
│   ├── queries.ts       # Query helpers
│   ├── migrate.ts       # Migration runner
│   └── migrations/      # 001–008
├── tools/
│   ├── packs.ts         # Tool pack selection (embedding-based)
│   ├── core/            # Always-loaded: memory, schedule, secrets, identity, usage
│   ├── self/            # Self-modification: read, edit, test, logs, deploy, status, extension_reload
│   ├── web/             # Web search (Tavily) + web read
│   └── telegram/        # React, reply-to, pin/unpin, get-pinned
├── telegram/
│   ├── bot.ts           # Grammy handlers, queue/threading
│   ├── format.ts        # Markdown → Telegram HTML
│   ├── types.ts
│   └── index.ts
├── scheduler/
│   └── index.ts         # Croner reminder daemon
├── extensions/
│   ├── loader.ts        # Dynamic tool/skill loader (jiti)
│   ├── embeddings.ts    # Extension pack embeddings
│   ├── secrets.ts       # Secrets table + EXT_* sync
│   └── types.ts
└── __tests__/           # Integration tests (memory pipelines, graph, context)
```

## Cortex Directory Structure

```
apps/cortex/src/
├── main.ts              # Boot, migrations, token seeding, backfill, daemon loop
├── env.ts               # Zod env: OPENROUTER_API_KEY, TRACKED_TOKENS, intervals
├── ingest/
│   ├── prices.ts        # CoinGecko price fetching
│   ├── news.ts          # CryptoPanic + CryptoCompare RSS news
│   └── types.ts
├── pipeline/
│   ├── loop.ts          # Croner jobs: prices, news, signals, command queue
│   ├── analyzer.ts      # LLM signal generation (hybrid recall + graph context)
│   ├── prompts.ts       # Short/long signal prompt templates
│   └── backfill.ts      # Historical data backfill
└── db/
    ├── schema.ts        # tracked_tokens, price_snapshots, news_items, signals, commands
    ├── queries.ts
    └── migrations/
```

## Synapse Directory Structure

```
apps/synapse/src/
├── main.ts              # Boot, migrations, portfolio init, executor, daemon loop
├── env.ts               # Zod env: portfolio config, risk params, position sizing
├── status.ts            # CLI portfolio summary script
├── types.ts             # Executor interface (buy/sell -> ExecutionResult)
├── cortex/
│   ├── reader.ts        # Read-only access to Cortex DB (signals, prices, tokens)
│   └── types.ts
├── engine/
│   ├── loop.ts          # Croner jobs: signal poll, risk check
│   ├── executor.ts      # PaperExecutor (simulated fills with slippage + gas)
│   ├── signal-filter.ts # Confidence thresholds, cooldown, dedup
│   ├── position-sizer.ts # Kelly-inspired sizing by confidence
│   ├── risk.ts          # Stop-loss, take-profit, drawdown halt, exposure limits
│   └── pricing.ts       # Price fetching from Cortex DB
├── portfolio/
│   └── tracker.ts       # Position price updates, portfolio recalc, snapshots
└── db/
    ├── schema.ts        # positions, trades, signal_log, risk_events, portfolio_state
    ├── queries.ts
    └── migrations/
```

## Deck Directory Structure

```
apps/deck/
├── src/
│   ├── server.ts        # Hono app: CORS, DB injection, static serving
│   ├── env.ts           # DATABASE_URL, PORT (4800)
│   └── routes/
│       ├── memories.ts  # /api/memories (search, list, detail)
│       ├── graph.ts     # /api/graph (nodes, edges, traversal)
│       ├── observations.ts # /api/observations (timeline)
│       └── stats.ts     # /api/stats (counts)
└── web/                 # React SPA (Vite)
    └── src/
        ├── App.tsx      # Routes: /, /memories, /observations
        └── components/  # GraphView (D3-force canvas), MemoryBrowser, ObservationTimeline
```

## Optic Structure

```
apps/optic/src/
├── main.rs              # CLI args, DB connections, terminal setup, event loop
├── db.rs                # CortexDb + SynapseDb (rusqlite, read-only)
└── ui.rs                # Ratatui rendering: Market view + Trading view
```

Two view modes: **Market** (prices, chart, news, signals, graph) and **Trading** (positions, trades, signal log, risk events). Reads Cortex DB for market data, optionally Synapse DB for portfolio. Auto-refreshes every 5s. Keybinds: `q` quit, `Tab` focus, `j/k` scroll, `c` chart cycle, `a` analyze, `1/2` mode switch.

## Shared Packages

### @repo/cairn (`packages/cairn/`)

Memory substrate shared by Construct, Cortex, and Deck. Provides:

- **MemoryManager**: Facade for the full pipeline (observer, reflector, promoter, graph)
- **Observer**: LLM-based message compression into observations (batched, watermarked)
- **Reflector**: Condenses observations when token budget exceeds threshold
- **Promoter**: Embedding-deduped promotion of observations to long-term memories
- **Graph**: Entity/relationship extraction from memories (LLM-powered)
- **Context**: Observation rendering with priority-based budget eviction
- **Embeddings**: OpenRouter embedding generation + cosine similarity
- **DB queries**: Memory CRUD, FTS5 search, hybrid recall, graph queries

```
packages/cairn/src/
├── index.ts             # Barrel exports
├── manager.ts           # MemoryManager class
├── observer.ts          # observe() - message -> observations
├── reflector.ts         # reflect() - condense observations
├── context.ts           # renderObservations(), buildContextWindow()
├── embeddings.ts        # generateEmbedding(), cosineSimilarity()
├── tokens.ts            # estimateTokens()
├── types.ts             # Observation, GraphNode, GraphEdge, etc.
├── db/
│   ├── types.ts         # CairnDatabase schema (memories, observations, graph_*)
│   └── queries.ts       # storeMemory, recallMemories, trackUsage, etc.
└── graph/
    ├── index.ts         # processMemoryForGraph() orchestrator
    ├── extract.ts       # extractEntities() via LLM
    └── queries.ts       # searchNodes, traverseGraph, upsertNode/Edge
```

### @repo/db (`packages/db/`)

Kysely database factory and migration runner shared across all JS apps. Two exports:
- `createDb<T>(path)` -- creates Kysely instance with node:sqlite dialect
- `runMigrations(path, migrations)` -- file-based migration runner

## Extensions Directory

Location: `EXTENSIONS_DIR` env var (defaults to `./data` in dev, `$XDG_DATA_HOME/construct/` in prod).

```
$EXTENSIONS_DIR/
├── SOUL.md              # Personality (injected into system prompt)
├── IDENTITY.md          # Agent metadata: name, type, pronouns
├── USER.md              # Human context: name, location, preferences
├── skills/              # Markdown skills (YAML frontmatter + body)
└── tools/               # TypeScript tools (hot-loaded via jiti)
```

## Environment Variables

All env files live in the repo root with the naming convention `.env.<app>` (e.g. `.env.construct`, `.env.cortex`, `.env.synapse`, `.env.deck`). Example files: `.env.<app>.example`. The Justfile passes these via `node --env-file=.env.<app>`. All SQLite databases go in `./data/` so apps can share DBs by path.

### Construct

**Required**: `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`

**Optional**:
- `NODE_ENV` -- `development` | `production` (default: production)
- `OPENROUTER_MODEL` -- LLM model (default: `google/gemini-3-flash-preview`)
- `DATABASE_URL` -- SQLite path (default: `./data/construct.db`)
- `ALLOWED_TELEGRAM_IDS` -- Comma-separated Telegram user IDs
- `TIMEZONE` -- Agent timezone (default: `UTC`)
- `TAVILY_API_KEY` -- Web search
- `LOG_LEVEL` / `LOG_FILE` -- Logging config
- `PROJECT_ROOT` -- Scope for self-edit tools (default: `.`)
- `EXTENSIONS_DIR` -- Extensions directory path
- `EMBEDDING_MODEL` -- Embedding model (default: `qwen/qwen3-embedding-4b`)
- `MEMORY_WORKER_MODEL` -- Dedicated model for memory workers
- `EXT_*` -- Synced to secrets table on startup (prefix stripped)

### Cortex

**Required**: `OPENROUTER_API_KEY`

**Optional**:
- `DATABASE_URL` -- SQLite path (default: `./data/cortex.db`)
- `TRACKED_TOKENS` -- Comma-separated CoinGecko IDs (default: `bitcoin,ethereum`)
- `CRYPTOPANIC_API_KEY` / `CRYPTOCOMPARE_API_KEY` -- News sources
- `EMBEDDING_MODEL` / `MEMORY_WORKER_MODEL` / `ANALYZER_MODEL` -- LLM config
- `PRICE_INTERVAL` / `NEWS_INTERVAL` / `SIGNAL_INTERVAL` -- Seconds between cycles

### Synapse

**Optional** (all have defaults):
- `CORTEX_DATABASE_URL` -- Cortex DB to read signals from (default: `./data/cortex.db`)
- `DATABASE_URL` -- Synapse DB (default: `./data/synapse.db`)
- `INITIAL_BALANCE_USD` -- Starting paper balance (default: `10000`)
- `POLL_INTERVAL` / `RISK_CHECK_INTERVAL` -- Loop timing (seconds)
- `MIN_CONFIDENCE_SHORT` / `MIN_CONFIDENCE_LONG` -- Signal thresholds
- `MAX_POSITION_PCT` / `MAX_PORTFOLIO_DRAWDOWN_PCT` / `STOP_LOSS_PCT` / `TAKE_PROFIT_PCT` -- Risk params
- `SLIPPAGE_BPS` / `SIMULATED_GAS_USD` -- Execution simulation

### Deck

- `DATABASE_URL` -- DB to browse (default: `./data/construct.db`)
- `PORT` -- Server port (default: `4800`)

### Optic

- First positional arg or `DATABASE_URL` -- Cortex DB path
- `--synapse <path>` or `SYNAPSE_DATABASE_URL` -- Synapse DB path
