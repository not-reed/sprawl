# Sprawl Documentation

Documentation for the Sprawl monorepo: five apps, two shared packages, one memory pipeline.

## Apps

- **[Cortex](./apps/cortex.md)** -- Crypto market intelligence daemon. Ingests prices + news, feeds them through Cairn's memory pipeline, generates LLM-grounded trading signals.
- **[Synapse](./apps/synapse.md)** -- Paper trading daemon. Reads Cortex signals, sizes positions by confidence, manages risk with stop-losses and drawdown limits.
- **[Deck](./apps/deck.md)** -- Memory graph explorer. Hono REST API + React SPA with D3-force graph visualization, memory browser, and observation timeline.
- **[Optic](./apps/optic.md)** -- Terminal trading dashboard. Ratatui TUI that reads Cortex + Synapse DBs. Market view (prices, charts, news, signals, graph) and trading view (positions, trades, risk events).

## Construct (flagship)

### Architecture

- **[Architecture Overview](./architecture/overview.md)** -- Startup sequence, data flow, key design decisions (embedding-based tool selection, static/dynamic prompt split, self-modification safety)

### Features

- **[Agent System](./features/agent.md)** -- The `processMessage()` pipeline: conversation management, memory loading, embedding generation, skill selection, context preamble, tool registration, pi-agent execution, and response persistence
- **[Memory System](./features/memory.md)** -- Three-layer memory: declarative, graph, and observational. Schema, tools, embeddings, and `processMessage()` integration.
- **[Tool System](./features/tools.md)** -- Tool packs (core, web, self, telegram), embedding-based pack selection, `InternalTool` interface, TypeBox schemas, Telegram side-effects pattern.
- **[Extension System](./features/extensions.md)** -- User-authored skills (Markdown) and dynamic tools (TypeScript via jiti). Identity files, secrets management, reload mechanism.
- **[Database Layer](./features/database.md)** -- SQLite via node:sqlite + Kysely. Tables, FTS5 search, embedding storage, query functions.
- **[Telegram Integration](./features/telegram.md)** -- Grammy bot, authorization, typing indicators, Markdown-to-HTML, message chunking, reactions.
- **[Scheduler / Reminders](./features/scheduler.md)** -- Croner scheduling, cron expressions, one-shot reminders, 30s sync loop.
- **[CLI Interface](./features/cli.md)** -- Citty CLI: REPL, one-shot, direct tool invocation.
- **[System Prompt](./features/system-prompt.md)** -- Static system prompt + dynamic context preamble.

## Shared Packages

- **[Cairn](./packages/cairn.md)** -- Memory substrate shared by Construct, Cortex, and Deck. Observer/reflector pipeline, embeddings, graph extraction, context building.

## Guides

- **[Deployment Guide](./guides/deployment.md)** -- Docker and systemd deployment, self-deploy behavior.
- **[Security Considerations](./guides/security.md)** -- Self-modification safety, secrets, extension trust, Telegram auth.
- **[Environment Configuration](./guides/environment.md)** -- All env vars across all apps, Zod validation.
- **[Development Workflow](./guides/development.md)** -- Just commands, testing, logging, TypeScript config.
