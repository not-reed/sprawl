# Construct Documentation

Construct is a personal braindump companion that communicates via Telegram, stores long-term memories in SQLite, handles reminders, and can read/edit/test/deploy its own source code. This directory contains comprehensive documentation of the system's architecture, features, and development workflow.

## Architecture

- **[Architecture Overview](./architecture/overview.md)** -- How all the pieces fit together: startup sequence, data flow, key design decisions (embedding-based tool selection, static/dynamic prompt split, self-modification safety)

## Features

- **[Agent System](./features/agent.md)** -- The `processMessage()` pipeline: conversation management, memory loading, embedding generation, skill selection, context preamble, tool registration, pi-agent execution, and response persistence
- **[Memory System](./features/memory.md)** -- Three-layer memory: declarative (facts/preferences with hybrid search), graph (entity-relationship extraction and associative recall), and observational (automatic conversation compression via observer/reflector LLM pipeline). Covers schema, tools, embeddings, and `processMessage()` integration.
- **[Tool System](./features/tools.md)** -- Tool packs (core, web, self, telegram), embedding-based pack selection, the `InternalTool` interface, TypeBox schemas, and the Telegram side-effects pattern. Includes detailed descriptions of all 24+ tools.
- **[Extension System](./features/extensions.md)** -- User-authored skills (Markdown with YAML frontmatter) and dynamic tools (TypeScript loaded via jiti). Identity files (SOUL.md, IDENTITY.md, USER.md), secrets management, requirement checking, and the reload mechanism.
- **[Database Layer](./features/database.md)** -- SQLite via node:sqlite with a custom Kysely dialect. Ten tables (memories, conversations, messages, schedules, ai_usage, settings, secrets, graph_nodes, graph_edges, observations), FTS5 full-text search, embedding storage, and all query functions.
- **[Telegram Integration](./features/telegram.md)** -- Grammy bot with long polling, authorization, typing indicators, Markdown-to-HTML conversion, message chunking, reaction handling, and message ID tracking.
- **[Scheduler / Reminders](./features/scheduler.md)** -- Croner-based scheduling with cron expressions and one-shot reminders. 30-second sync loop, auto-cancellation, and systemd integration.
- **[CLI Interface](./features/cli.md)** -- Citty-based CLI with interactive REPL, one-shot messages, and direct tool invocation modes.
- **[System Prompt](./features/system-prompt.md)** -- Two-layer prompt design: static system prompt (base rules + identity files) and dynamic context preamble (date, memories, skills, reply context).

## Guides

- **[Deployment Guide](./guides/deployment.md)** -- Docker deployment (primary), volume layout, self-deploy behavior in Docker vs systemd, image rebuilds, and legacy systemd setup.
- **[Security Considerations](./guides/security.md)** -- Self-modification safety gates, secrets management, Docker security, extension trust model, and Telegram authorization.
- **[Environment Configuration](./guides/environment.md)** -- All environment variables (required and optional), Zod validation, EXTENSIONS_DIR defaults, and EXT_* secret syncing.
- **[Development Workflow](./guides/development.md)** -- npm scripts, TypeScript configuration, testing with Vitest, logging with Logtape, self-deploy pipeline, dev mode differences, and dependency inventory.

## Quick Reference

### Directory Structure

```
src/
  main.ts              Entry point (startup orchestrator)
  agent.ts             processMessage() -- the central pipeline
  system-prompt.ts     System prompt construction
  embeddings.ts        OpenRouter embeddings + cosine similarity
  env.ts               Zod-validated environment config
  logger.ts            Logtape logging with file rotation
  db/
    index.ts           Custom Kysely dialect for node:sqlite
    schema.ts          TypeScript table types
    queries.ts         All query functions
    migrate.ts         Migration runner
    migrations/        001-initial through 006-observational-memory
  memory/
    index.ts           MemoryManager facade (graph + observational memory)
    observer.ts        Observer LLM -- compresses messages into observations
    reflector.ts       Reflector LLM -- condenses observations
    context.ts         Observation rendering for context injection
    tokens.ts          Token estimation utilities
    types.ts           Shared types (Observation, GraphNode, GraphEdge, etc.)
    graph/
      index.ts         processMemoryForGraph() orchestrator
      extract.ts       Entity/relationship extraction via LLM
      queries.ts       Graph node/edge CRUD, traversal, search
  tools/
    packs.ts           Pack definitions, selection, embedding cache
    core/              Memory, schedule, secret, identity, usage tools
    self/              Source read/edit, test, deploy, logs, status, extension reload
    web/               Web read (Jina), web search (Tavily)
    telegram/          React, reply-to, pin, unpin, get-pinned
  extensions/
    index.ts           Singleton registry, init, reload
    loader.ts          File loading (identity, skills, dynamic tools via jiti)
    embeddings.ts      Skill + dynamic pack embedding caches
    secrets.ts         Secret CRUD and env sync
    types.ts           Extension type definitions
  telegram/
    bot.ts             Grammy bot, message/reaction handlers
    index.ts           Standalone Telegram entry point
    types.ts           TelegramContext, TelegramSideEffects
  scheduler/
    index.ts           Croner job management
cli/
  index.ts             Citty CLI (REPL, one-shot, tool invoke)
```

### Tech Stack

| Component | Library |
|-----------|---------|
| Runtime | Node.js + tsx |
| Agent | @mariozechner/pi-agent-core |
| LLM | OpenRouter (OpenAI-compatible) |
| Database | node:sqlite + Kysely |
| Telegram | Grammy |
| CLI | Citty |
| Scheduler | Croner |
| Testing | Vitest |
| Dynamic loading | jiti |
| Schemas | @sinclair/typebox (tools), Zod (env) |
| Logging | @logtape/logtape |
