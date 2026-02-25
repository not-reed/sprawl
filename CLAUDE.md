# Construct

Personal braindump companion. Communicates via Telegram, stores long-term memories in SQLite, handles reminders, and can read/edit/test/deploy its own source.

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
                    │  - secret_*   │
                    │  - ext tools  │
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
- **Database**: SQLite via node:sqlite + Kysely
- **Telegram**: Grammy (long polling)
- **CLI**: Citty
- **Scheduler**: Croner
- **Testing**: Vitest
- **Dynamic tool loading**: jiti (TypeScript without compile step)

## Key Conventions

- **Tools** follow the `{ name, description, parameters, execute }` pattern with TypeBox schemas
- **Migrations** are additive only — never drop tables or columns
- **Self-aware tools** are scoped to `src/`, `cli/`, and `extensions/` — never system files
- **Self-deploy** requires passing tests first and is rate-limited to 3/hour
- **Extensions** are user/agent-authored skills (Markdown) and tools (TypeScript) loaded from `EXTENSIONS_DIR`

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
- `src/system-prompt.ts` — System prompt with context injection, SOUL.md support
- `src/tools/` — All built-in tool implementations (memory, schedule, self-*, secret-*)
- `src/extensions/` — Extension system (loader, embeddings, secrets, types)
- `src/telegram/` — Grammy bot setup
- `src/scheduler/` — Croner-based reminder system
- `src/db/` — Kysely database, schema, queries, migrations
- `src/env.ts` — Zod-validated environment variables
- `cli/` — Citty-based CLI (REPL, one-shot, direct tool invocation)

## Extensions Directory

Location controlled by `EXTENSIONS_DIR` env var (defaults to `./data` in dev, `$XDG_DATA_HOME/construct/` in prod).

```
$EXTENSIONS_DIR/
├── SOUL.md                    # Personality traits, values, anti-patterns (injected into system prompt)
├── IDENTITY.md                # Agent metadata: name, creature type, visual description, pronouns
├── USER.md                    # Human context: name, location, preferences, interests, schedule
├── skills/
│   ├── daily-standup.md       # Standalone skill (YAML frontmatter + body)
│   └── coding/
│       └── code-review.md     # Skills can be nested
└── tools/
    ├── weather.ts             # Standalone tool → individual embedding
    └── music/                 # Directory = pack → pack embedding
        ├── pack.md            # Optional: pack description override
        ├── play.ts
        └── search.ts
```

## Extension Tools

- `secret_store` / `secret_list` / `secret_delete` — Manage secrets for extensions (always loaded in core pack)
- `extension_reload` — Reload all extensions from disk (loaded with self pack)
- `self_read_source` / `self_edit_source` — Now support `extensions/` path prefix

## Environment Variables

- `EXTENSIONS_DIR` — Extensions directory path (optional, has smart defaults)
- `EXT_*` — Any env var prefixed with `EXT_` is synced to the secrets table on startup (prefix stripped)
