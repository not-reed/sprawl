# Copilot Instructions

## Project Overview

Monorepo for personal AI tools. Five apps + two shared packages, all converging on SQLite.

- **construct** - AI companion (Telegram + CLI + scheduler), uses LLM agent with tool system
- **cortex** - Crypto market intelligence daemon (price/news ingestion, LLM signal generation)
- **synapse** - Paper trading daemon (reads cortex signals, simulated execution)
- **deck** - Memory graph explorer (Hono API + React/D3 SPA)
- **optic** - Terminal trading dashboard (Rust/Ratatui, reads cortex+synapse DBs)
- **@repo/cairn** - Memory substrate (observer/reflector/promoter/graph pipeline, embeddings, FTS5)
- **@repo/db** - Shared Kysely database factory + migration runner

## Tech Stack

- TypeScript (Node.js + tsx), Rust (optic only)
- pnpm workspace monorepo, Just task runner (`Justfile`)
- SQLite via `node:sqlite` + Kysely (JS apps), rusqlite (Rust)
- Vitest for testing, oxlint for linting, oxfmt for formatting
- TypeBox for tool parameter schemas, Zod for env validation
- LLM via OpenRouter (OpenAI-compatible API)

## Code Conventions

### Tool definitions

Tools follow a strict shape: `{ name, description, parameters, execute }`. Parameters use TypeBox schemas (`Type.Object`, `Type.String`, etc.). See `apps/construct/src/tools/` for examples.

### Database migrations

Migrations are **additive only**. Never drop tables or columns. Migration files live in each app/package's `db/migrations/` directory.

### Error handling

Each package/app defines custom error classes in `errors.ts`. Use these instead of generic `Error`:

- `@repo/cairn`: `MemoryError`, `EmbeddingError`, `GraphError`
- `@repo/db`: `DatabaseError`, `MigrationError`
- `construct`: `ToolError`, `ExtensionError`, `AgentError`, `ConfigError`
- `cortex`: `IngestError`, `AnalyzerError`
- `synapse`: `ExecutionError`, `RiskError`

### Environment variables

Each app validates env with Zod in `src/env.ts`. Env files use `.env.<app>` naming at repo root.

### Testing

Tests use Vitest. Test files live in `__tests__/` directories. Factory functions for test data go in `__tests__/fixtures.ts`. Run with `just test`.

### Public APIs

Exported functions and classes should have JSDoc comments.

## PR Review Checklist

- [ ] Migrations are additive only (no DROP TABLE, DROP COLUMN, or destructive ALTER)
- [ ] Custom error classes from `errors.ts` are used, not bare `Error`
- [ ] New exported APIs have JSDoc documentation
- [ ] New code has test coverage
- [ ] No SQL injection vectors (use parameterized queries via Kysely, never string interpolation)
- [ ] No command injection in any shell/exec calls
- [ ] No secrets or credentials in committed code
- [ ] Env variables are added to the app's `env.ts` Zod schema and `.env.<app>.example`
