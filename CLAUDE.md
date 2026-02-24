# Nullclaw

Personal braindump companion running on a Raspberry Pi 2 Model B. Communicates via Telegram, stores long-term memories in SQLite, handles reminders, and can read/edit/test/deploy its own source.

## Architecture

```
┌─────────────┐     ┌──────────────┐
│  Telegram    │────▶│              │
│  (Grammy)    │     │   AI Agent   │
├─────────────┤     │ (pi-agent)   │
│    CLI       │────▶│              │
│  (Citty)     │     │  Tools:      │
└─────────────┘     │  - memory_*  │
                    │  - schedule_* │
                    │  - self_*     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   SQLite     │
                    │  (Kysely)    │
                    └──────────────┘
```

All interactions flow through `processMessage()` in `src/agent.ts`.

## Tech Stack

- **Runtime**: Node.js + tsx (ARMv7 compatible)
- **Agent**: @mariozechner/pi-agent-core
- **LLM**: OpenRouter (OpenAI-compatible)
- **Database**: SQLite via better-sqlite3 + Kysely
- **Telegram**: Grammy (long polling)
- **CLI**: Citty
- **Scheduler**: Croner
- **Testing**: Vitest

## Key Conventions

- **Tools** follow the `{ name, description, parameters, execute }` pattern with TypeBox schemas
- **Migrations** are additive only — never drop tables or columns
- **Self-aware tools** are scoped to `src/` and `cli/` only — never system files
- **Self-deploy** requires passing tests first and is rate-limited to 3/hour

## Scripts

```bash
npm run dev          # Dev mode with file watching
npm run start        # Production start
npm run cli          # Interactive CLI
npm run telegram     # Telegram bot only
npm run db:migrate   # Run migrations
npm run test         # Run tests
npm run typecheck    # Type checking
```

## Directory Structure

- `src/agent.ts` — Agent factory, processMessage(), tool registration
- `src/system-prompt.ts` — System prompt with context injection
- `src/tools/` — All tool implementations (memory, schedule, self-*)
- `src/telegram/` — Grammy bot setup
- `src/scheduler/` — Croner-based reminder system
- `src/db/` — Kysely database, schema, queries, migrations
- `src/env.ts` — Zod-validated environment variables
- `cli/` — Citty-based CLI (REPL, one-shot, direct tool invocation)
