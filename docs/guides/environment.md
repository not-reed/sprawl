---
title: Environment Configuration
description: Environment variables and Zod validation
---

# Environment Configuration

## Overview

Each app has its own Zod-validated env config in `src/env.ts`. Env files live in the repo root with the naming convention `.env.<app>` (e.g., `.env.construct`, `.env.cortex`, `.env.synapse`, `.env.deck`, `.env.loom`). The Justfile passes these via `node --env-file=.env.<app>`. Example files: `.env.<app>.example`.

See the root `CLAUDE.md` for a full per-app env variable reference. This page covers Construct's env config in detail.

## Key Files

| File | Role |
|------|------|
| `apps/construct/src/env.ts` | Zod schema, validation, `env` export |
| `.env.construct.example` | Template with all variables and defaults |

## Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `OPENROUTER_API_KEY` | API key for OpenRouter (LLM and embeddings) | `sk-or-v1-...` |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token from @BotFather | `123456:ABC-DEF...` |

## Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `'production'` | Set to `'development'` for dev mode |
| `OPENROUTER_MODEL` | `'google/gemini-3-flash-preview'` | LLM model identifier for OpenRouter |
| `DATABASE_URL` | `'./data/construct.db'` | Path to SQLite database file |
| `ALLOWED_TELEGRAM_IDS` | `''` (allow all) | Comma-separated Telegram user IDs |
| `TIMEZONE` | `'UTC'` | Timezone for date display and context (e.g., `'America/New_York'`) |
| `LOG_LEVEL` | `'info'` | Logging level: `debug`, `info`, `warning`, `error`, `fatal` |
| `LOG_FILE` | `'./data/construct.log'` | Path to the log file |
| `PROJECT_ROOT` | `'.'` | Resolved to absolute path. Root for self-read/edit tools |
| `TAVILY_API_KEY` | (none) | API key for Tavily web search. If absent, `web_search` tool is disabled |
| `EXTENSIONS_DIR` | Smart default (see below) | Path to extensions directory |

## EXTENSIONS_DIR Defaults

The extensions directory has environment-aware defaults:

- **Development** (`NODE_ENV=development`): `./data`
- **Production**: `$XDG_DATA_HOME/construct/` or `~/.local/share/construct/`

## Extension Secrets (EXT_* Variables)

Any environment variable with the `EXT_` prefix is automatically synced to the `secrets` table on startup. The prefix is stripped:

```bash
EXT_OPENWEATHERMAP_API_KEY=abc123
# Becomes secret key: OPENWEATHERMAP_API_KEY
```

These secrets are then available to dynamic extension tools via `DynamicToolContext.secrets`. Environment-sourced secrets always overwrite existing values on restart (source is set to `'env'`).

## Validation

`src/env.ts` uses Zod to parse and validate `process.env`:

```typescript
const envSchema = z.object({
  OPENROUTER_API_KEY: z.string(),            // Required
  TELEGRAM_BOT_TOKEN: z.string(),            // Required
  NODE_ENV: z.string().default('production'),
  OPENROUTER_MODEL: z.string().default('google/gemini-3-flash-preview'),
  DATABASE_URL: z.string().default('./data/construct.db'),
  ALLOWED_TELEGRAM_IDS: z.string().default('').transform(s => s.split(',').filter(Boolean)),
  TIMEZONE: z.string().default('UTC'),
  LOG_LEVEL: z.string().default('info'),
  LOG_FILE: z.string().default('./data/construct.log'),
  PROJECT_ROOT: z.string().default('.').transform(p => resolve(p)),
  EXTENSIONS_DIR: z.string().default(defaultExtensionsDir()).transform(p => resolve(p)),
  TAVILY_API_KEY: z.string().optional(),
})

export const env = envSchema.parse(process.env)
```

Notable transforms:
- `ALLOWED_TELEGRAM_IDS` is split into a string array
- `PROJECT_ROOT` and `EXTENSIONS_DIR` are resolved to absolute paths

If required variables are missing, the application fails immediately with a Zod validation error.

## Loading Mechanism

Variables are loaded via Node.js `--env-file` flag, invoked through the Justfile:

```bash
just dev                # NODE_ENV=development node --env-file=.env.construct --import=tsx ...
just start myinstance   # node --env-file=.env.myinstance --import=tsx src/main.ts
```

This is a native Node.js feature (v20.6+), not a third-party dotenv library. All SQLite databases go in `./data/` so apps can share DBs by path.
