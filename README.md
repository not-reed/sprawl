```
███████╗██████╗ ██████╗  █████╗ ██╗    ██╗██╗
██╔════╝██╔══██╗██╔══██╗██╔══██╗██║    ██║██║
███████╗██████╔╝██████╔╝███████║██║ █╗ ██║██║
╚════██║██╔═══╝ ██╔══██╗██╔══██║██║███╗██║██║
███████║██║     ██║  ██║██║  ██║╚███╔███╔╝███████╗
╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝
```

> *"The Sprawl was a long strange way, home to millions, most of them sleeping."*
>
> -- William Gibson, *Neuromancer*

---

**The Sprawl** is a monorepo of personal AI tools -- a constellation of daemons, agents, and memory systems wired together through shared databases and a common memory substrate. Built with pnpm workspaces, orchestrated with [Just](https://github.com/casey/just).

## The Wire

```
╔═══════════════╗  ╔═══════════════╗  ╔═══════════════╗  ╔═══════════════╗  ╔═══════════════╗
║   CONSTRUCT   ║  ║    CORTEX     ║  ║     DECK      ║  ║    SYNAPSE    ║  ║     OPTIC     ║
║  braindump    ║  ║  market intel ║  ║  graph UI     ║  ║  paper trade  ║  ║  trade        ║
║  companion    ║  ║  pipeline     ║  ║  explorer     ║  ║  daemon       ║  ║  dashboard    ║
╚═══════╤═══════╝  ╚═══════╤═══════╝  ╚═══════╤═══════╝  ╚═══════╤═══════╝  ╚═══════╤═══════╝
        │                  │                  │                  │                  │
        └──────────────────┼──────────────────┘                  │                  │
                           │                                     │                  │
              ╔════════════▼════════════╗                        │                  │
              ║        @repo/cairn      ║                        │                  │
              ║  observe → reflect →    ║                        │                  │
              ║  promote → graph        ║                        │                  │
              ╚════════════╤════════════╝                        │                  │
                           │                                     │                  │
              ╔════════════▼═════════════════════════════════════▼═══╗              │
              ║                    @repo/db                          ║              │
              ║               kysely + migrations                    ║              │
              ╚══════════════════════╤═══════════════════════════════╝              │
                                     │                                              │
              ╔══════════════════════▼══════════════════════════════════════════════▼══╗
              ║                              SQLITE                                    ║
              ╚════════════════════════════════════════════════════════════════════════╝
```

Five apps. Two shared packages. One memory pipeline. Everything converges in SQLite. Optic reads the databases directly via rusqlite -- no JS runtime needed.

## Apps

### Construct (`apps/construct/`)

Self-aware braindump companion. A ROM personality that listens on Telegram, stores long-term memories in SQLite, wakes you with reminders, and can reach into its own source code to rewrite itself.

- **Agent**: [@mariozechner/pi-agent-core](https://github.com/nicepkg/pi-agent) + OpenRouter
- **Interfaces**: Telegram (Grammy), CLI (Citty), Scheduler (Croner)
- **Memory**: Observer/reflector pipeline, FTS5 + semantic search, knowledge graph
- **Tools**: Memory, scheduling, web search/read, self-modification, Telegram actions, secrets, identity management
- **Extensions**: Hot-loadable skills (Markdown) and tools (TypeScript) from disk

### Cortex (`apps/cortex/`)

Crypto market intelligence daemon. Ingests prices and news on cron loops, feeds them through cairn's memory pipeline, builds a knowledge graph of market entities, and generates trading signals grounded in accumulated context.

### Synapse (`apps/synapse/`)

Paper trading daemon. Reads signals from Cortex, sizes positions by confidence, manages risk with stop-losses and drawdown limits. No real money -- just simulation against live data, measuring what conviction is worth.

### Deck (`apps/deck/`)

Observability layer. REST API + web UI for navigating the knowledge graph, searching memories, and tracing the observation pipeline. D3-force on canvas, Hono on the backend.

### Optic (`apps/optic/`)

Terminal trading dashboard. Displays prices, news feeds, signals from Cortex, and trade status from Synapse. Ratatui (Rust).

## Shared ICE

| Package | Description |
|---|---|
| `@repo/cairn` | Memory substrate -- observer/reflector, embeddings, graph extraction, context building |
| `@repo/db` | Shared Kysely database factory + migration runner |

## Construct Toolbox

| Pack | Tools |
|------|-------|
| **core** (always loaded) | `memory_store`, `memory_recall`, `memory_forget`, `memory_graph`, `schedule_create`, `schedule_list`, `schedule_cancel`, `secret_manage`, `identity_read`, `identity_update`, `usage_stats` |
| **self** | `self_read_source`, `self_edit_source`, `self_run_tests`, `self_view_logs`, `self_deploy`, `self_status`, `extension_reload` |
| **web** | `web_search`, `web_read` |
| **telegram** | `telegram_react`, `telegram_reply_to`, `telegram_pin`, `telegram_unpin`, `telegram_get_pinned` |

Tool packs are semantically selected per message via embedding similarity. Core always loads; others activate when relevant.

## Bootstrapping

### Prerequisites

- Node.js 22+ (`node:sqlite` support)
- pnpm
- [Just](https://github.com/casey/just) task runner
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An OpenRouter API key (from [openrouter.ai](https://openrouter.ai))

### Install

```bash
git clone <repo>
cd sprawl
pnpm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Required
OPENROUTER_API_KEY=sk-or-...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Optional
OPENROUTER_MODEL=google/gemini-3-flash-preview
ALLOWED_TELEGRAM_IDS=123456
TIMEZONE=America/New_York
DATABASE_URL=./data/construct.db
TAVILY_API_KEY=tvly-...
```

## Jacking In

```bash
# Construct -- Telegram + scheduler, dev mode with file watching
just dev

# Start a named instance (reads .env.<instance>)
just start myinstance

# CLI
just cli                # REPL
just cli "" "remember my dentist appointment is March 5th"

# Tests
just test               # all packages
just test-construct     # construct only
just test-ai            # AI integration tests

# Typecheck
just typecheck

# Cortex
just cortex-dev                # dev mode
just cortex-start              # production
just cortex-backfill 30        # backfill 30 days

# Synapse
just synapse-dev               # paper trading daemon
just synapse-start             # production
just synapse-status            # portfolio summary

# Deck
just deck-dev myinstance       # memory graph explorer

# Optic TUI
just optic                     # reads cortex + synapse DBs
just optic-build               # release binary
```

## Deploying to the Grid

```bash
sudo tee /etc/systemd/system/construct.service << 'EOF'
[Unit]
Description=Construct Braindump Companion
After=network.target

[Service]
Type=simple
User=claw
WorkingDirectory=/home/claw/construct
ExecStart=/usr/bin/node --env-file=.env --import=tsx apps/construct/src/main.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now construct
```

## Neural Map

```
sprawl/
├── apps/
│   ├── construct/            # AI braindump companion
│   │   └── src/
│   │       ├── agent.ts      # processMessage() pipeline
│   │       ├── system-prompt.ts
│   │       ├── main.ts       # boot sequence
│   │       ├── env.ts        # zod env validation
│   │       ├── logger.ts     # logtape
│   │       ├── cli/          # citty CLI
│   │       ├── db/           # schema, queries, migrations
│   │       ├── tools/        # core/, self/, web/, telegram/
│   │       ├── telegram/     # grammy bot
│   │       ├── scheduler/    # croner reminders
│   │       └── extensions/   # dynamic loader (jiti)
│   ├── cortex/               # market intelligence daemon
│   │   └── src/
│   │       ├── main.ts       # boot, seeding, backfill, daemon
│   │       ├── ingest/       # prices (coingecko), news (cryptopanic/cryptocompare)
│   │       ├── pipeline/     # loop, analyzer, backfill, prompts
│   │       └── db/           # tokens, snapshots, news, signals, commands
│   ├── synapse/              # paper trading daemon
│   │   └── src/
│   │       ├── main.ts       # boot, portfolio init, executor, loop
│   │       ├── cortex/       # read-only access to cortex DB
│   │       ├── engine/       # signal filter, position sizer, risk, executor
│   │       ├── portfolio/    # price updates, recalc, snapshots
│   │       └── db/           # positions, trades, signal_log, risk_events
│   ├── deck/                 # memory graph explorer
│   │   ├── src/              # hono API (memories, graph, observations, stats)
│   │   └── web/              # react SPA (d3-force graph, memory browser)
│   └── optic/                # trade dashboard TUI (rust/ratatui)
│       └── src/              # market view + trading view, reads cortex+synapse DBs
├── packages/
│   ├── cairn/                # memory substrate
│   └── db/                   # shared DB layer
├── data/                     # runtime data (dev)
├── deploy/                   # deployment scripts
├── Justfile                  # task runner
└── pnpm-workspace.yaml
```

---

> *"Night City was like a deranged experiment in social Darwinism, designed by a bored researcher who kept one thumb permanently on the fast-forward button."*
>
> -- William Gibson, *Neuromancer*

The sprawl remembers. The sprawl watches. The sprawl trades on what it knows. And if you need to see what it sees, there's a deck for that.
