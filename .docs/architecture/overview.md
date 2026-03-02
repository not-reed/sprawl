# Architecture Overview

*Last updated: 2026-03-01 -- Expanded to cover full Sprawl monorepo*

## Overview

Sprawl is a monorepo of five apps sharing two packages and a SQLite-based data layer. The flagship app is Construct, a self-aware braindump companion. The trading pipeline (Cortex, Synapse, Optic) reuses the same memory substrate for market intelligence. Deck provides observability for any app's memory graph.

Construct runs as a long-lived Node.js process. It receives messages over Telegram (or a local CLI), processes them through an AI agent backed by OpenRouter, and uses SQLite for persistent storage of conversations, memories, schedules, secrets, and usage tracking.

The system is self-aware: it can read, edit, test, and deploy its own source code. It extends itself through a plugin-like extension system that supports user-authored skills (Markdown instructions) and tools (TypeScript modules).

## Monorepo Data Flow

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Construct   │  │   Cortex    │  │   Synapse   │  │    Deck     │  │    Optic    │
│  (agent)     │  │  (ingest)   │  │  (trading)  │  │  (web UI)   │  │  (TUI)      │
└──────┬───────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                 │                │                │                │
       └────────┬────────┘                │                │                │
                │                         │                │                │
       ┌────────▼────────┐                │                │                │
       │   @repo/cairn   │                │                │                │
       │  memory pipeline│────────────────│────────────────┘                │
       └────────┬────────┘                │                                 │
                │                         │                                 │
       ┌────────▼────────┐                │                                 │
       │    @repo/db     │────────────────┘                                 │
       │  kysely + sqlite│                                                  │
       └────────┬────────┘                                                  │
                │                                                           │
       ┌────────▼───────────────────────────────────────────────────────────▼──┐
       │                              SQLITE                                   │
       └──────────────────────────────────────────────────────────────────────┘
```

- Construct, Cortex, Deck use Cairn for memory (observe/reflect/promote/graph)
- Synapse reads Cortex's DB directly (signals, prices)
- Optic reads Cortex + Synapse DBs via rusqlite (no JS runtime)
- Each app manages its own database and migrations

## High-Level Architecture (Construct)

```
                         ┌──────────────────────────────────┐
                         │            src/main.ts            │
                         │     (startup orchestrator)        │
                         └────┬────┬────┬────┬────┬─────────┘
                              │    │    │    │    │
         ┌────────────────────┘    │    │    │    └──────────────────┐
         ▼                         ▼    │    ▼                      ▼
   ┌───────────┐          ┌────────┐   │  ┌──────────┐     ┌─────────────┐
   │  Database  │          │ Exts   │   │  │ Tool Pack│     │  Telegram   │
   │  migrate   │          │ init   │   │  │ Embeds   │     │  Bot start  │
   │  + create  │          │        │   │  │          │     │             │
   └─────┬─────┘          └────┬───┘   │  └────┬─────┘     └──────┬──────┘
         │                     │       │       │                   │
         ▼                     ▼       ▼       ▼                   ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                        processMessage()                             │
   │                         (src/agent.ts)                              │
   │                                                                     │
   │  1. Get/create conversation                                         │
   │  2. Load recent chat history (20 messages)                          │
   │  3. Load recent + semantically relevant memories                    │
   │  4. Select relevant skills via embedding similarity                 │
   │  5. Build context preamble (date, memories, skills, reply context)  │
   │  6. Construct system prompt (base + SOUL/IDENTITY/USER)             │
   │  7. Select tool packs via embedding similarity                      │
   │  8. Create pi-agent Agent, replay history, register tools           │
   │  9. Save user message, prompt agent, await completion               │
   │ 10. Save assistant response, track usage                            │
   └──────────────────────────────────────────────────────────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
   ┌──────────┐          ┌──────────────┐          ┌──────────────┐
   │  SQLite   │          │  OpenRouter  │          │  Tool Packs  │
   │  (Kysely) │          │  (LLM API)  │          │  (4 builtin  │
   │           │          │              │          │  + dynamic)  │
   └──────────┘          └──────────────┘          └──────────────┘
```

## Startup Sequence

The entry point is `src/main.ts`. On startup:

1. **Logging** -- Configure logtape with console + rotating file sinks (`src/logger.ts`)
2. **Database migrations** -- Run Kysely migrations to ensure schema is current (`src/db/migrate.ts`)
3. **Database connection** -- Create a Kysely instance backed by Node.js built-in `node:sqlite` (`src/db/index.ts`)
4. **Sync env secrets** -- Any `EXT_*` environment variables are written to the `secrets` table (`src/extensions/secrets.ts`)
5. **Initialize extensions** -- Load SOUL.md/IDENTITY.md/USER.md, skills, and dynamic tools from `EXTENSIONS_DIR`, compute their embeddings (`src/extensions/index.ts`)
6. **Pack embeddings** -- Pre-compute embedding vectors for non-always-load builtin tool pack descriptions (`src/tools/packs.ts`)
7. **Create Telegram bot** -- Set up Grammy bot with message and reaction handlers (`src/telegram/bot.ts`)
8. **Start scheduler** -- Load active schedules from DB and register Croner jobs (`src/scheduler/index.ts`)
9. **Start polling** -- Begin Telegram long-polling for messages and reactions
10. **Graceful shutdown** -- SIGINT/SIGTERM handlers stop scheduler, bot, and close DB

## Key Design Decisions

### Embedding-Based Tool Selection

Not all tools are loaded for every message. Tool packs have description embeddings computed at startup. When a message arrives, its embedding is compared against pack embeddings using cosine similarity. Only packs above a threshold (0.3) are loaded. Packs marked `alwaysLoad: true` (core, telegram) bypass this check. If embedding generation fails, all packs load as a graceful fallback.

### Static System Prompt + Dynamic Preamble

The system prompt is split into two parts for prompt caching efficiency:
- **Static system prompt**: Base instructions + identity files (SOUL.md, IDENTITY.md, USER.md). Cached and reused across requests.
- **Dynamic preamble**: Prepended to the user's message. Contains current date/time, recent memories, semantically relevant memories, active skills, and reply context.

### Node.js Built-in SQLite

Instead of using `better-sqlite3` (which requires native C++ compilation), the project uses Node.js built-in `node:sqlite` (`DatabaseSync`) with a custom Kysely dialect. This avoids compilation issues on ARM devices.

### Self-Modification Safety

The agent can edit its own source, but with guardrails:
- Edits are scoped to `src/`, `cli/`, and `extensions/` only
- Self-deploy runs typecheck and tests before committing
- Deploys are rate-limited to 3 per hour
- Auto-rollback if the service fails health check after restart
- Disabled entirely in development mode

## Related Documentation

### Construct features
- [Agent System](./../features/agent.md) -- processMessage() flow in detail
- [Tool System](./../features/tools.md) -- Packs, selection, and tool definitions
- [Extension System](./../features/extensions.md) -- Skills, dynamic tools, identity files
- [Database Layer](./../features/database.md) -- Schema, migrations, queries
- [Telegram Integration](./../features/telegram.md) -- Bot setup, message handling
- [Scheduler](./../features/scheduler.md) -- Reminders and cron jobs
- [CLI Interface](./../features/cli.md) -- REPL and one-shot modes
- [System Prompt](./../features/system-prompt.md) -- Prompt construction

### Other apps
- [Cortex](./../apps/cortex.md) -- Market intelligence daemon
- [Synapse](./../apps/synapse.md) -- Paper trading daemon
- [Deck](./../apps/deck.md) -- Memory graph explorer
- [Optic](./../apps/optic.md) -- Terminal trading dashboard

### Shared packages
- [Cairn](./../packages/cairn.md) -- Memory substrate

### Guides
- [Environment Configuration](./../guides/environment.md) -- Env vars and configuration
- [Development Workflow](./../guides/development.md) -- Just commands, testing, deployment
