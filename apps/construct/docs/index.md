---
title: Construct
description: Personal AI braindump companion
---

# Construct

## Overview

Personal AI braindump companion. Communicates via Telegram (primary interface), CLI (REPL + one-shot), and scheduled prompts. Uses an LLM agent with tool access, embedding-based tool/skill routing, a three-layer memory system (observations, memories, knowledge graph), and a self-modification capability that lets it edit its own source, create extensions, and deploy.

Construct is the flagship app in the Sprawl monorepo -- the only one with a conversational agent, tool system, and Telegram integration.

## How it works

### Boot sequence (`apps/construct/src/main.ts`)

1. Initialize Logtape logging
2. Run Kysely migrations on `DATABASE_URL`
3. Create database connection via `@repo/db`
4. Sync `EXT_*` environment variables into the `secrets` table (prefix stripped)
5. Load extensions: identity files (SOUL.md, IDENTITY.md, USER.md), skills, dynamic tools; compute their embeddings
6. Pre-compute builtin tool pack embeddings for semantic selection
7. Create Grammy Telegram bot
8. Start Croner scheduler (load active schedules, begin 30s sync loop)
9. Start Telegram long polling
10. Register SIGINT/SIGTERM for graceful shutdown

### The processMessage pipeline (`apps/construct/src/agent.ts`)

Every message -- from Telegram, CLI, or scheduler -- flows through `processMessage()`. This is the core orchestration function.

```
Input message
    |
    v
1. Get/create conversation (by source + externalId)
2. Create MemoryManager (Cairn) for this conversation
3. Build context window:
   - If observations exist: observations (compressed prefix) + un-observed messages (active suffix)
   - Fallback: last 20 raw messages
4. Load memories: 10 most recent + up to 5 semantically relevant (embedding similarity >= 0.4)
5. Select skills by embedding similarity to query
6. Build context preamble (date, timezone, source, observations, memories, skills, reply context)
7. Create pi-agent-core Agent with system prompt (base + identity files)
8. Select tool packs by embedding similarity, instantiate tools (builtin + dynamic)
9. Replay conversation history into agent (multi-turn context)
10. Subscribe to agent events (text deltas, usage tracking, tool call recording)
11. Save user message to DB
12. Run agent with preamble + message
13. Strip leaked [tg:ID] prefixes from response
14. Save assistant response + tool calls to DB
15. Track token usage + cost
16. Fire-and-forget: observer -> promoter -> reflector (async, non-blocking)
    |
    v
AgentResponse { text, toolCalls, usage, messageId }
```

The query embedding generated in step 4 is reused three times: memory recall, skill selection, and tool pack selection.

### System prompt (`apps/construct/src/system-prompt.ts`)

Two-layer design for prompt caching:

- **Static base prompt** (`BASE_SYSTEM_PROMPT`) -- Rules, Telegram interaction patterns, identity file guidance, extension conventions. Stays constant across requests.
- **Identity injection** -- SOUL.md, IDENTITY.md, USER.md appended to the base prompt. Cached until content changes (`invalidateSystemPromptCache()`).
- **Context preamble** -- Dynamic per-request data prepended to the user's message (not the system prompt). Contains: timestamp, timezone, source, dev mode flag, observations, recent/relevant memories, selected skills, reply context.

### Tool system (`apps/construct/src/tools/packs.ts`)

Tools are organized into **packs** -- groups selected per message by embedding similarity.

| Pack | Always loaded | Tools |
|------|---------------|-------|
| `core` | Yes | memory_store, memory_recall, memory_forget, memory_graph, schedule_create, schedule_list, schedule_cancel, secret_store, secret_list, secret_delete, usage_stats, identity_read, identity_update |
| `web` | No | web_read, web_search (requires `TAVILY_API_KEY`) |
| `self` | No | self_read, self_edit, self_test, self_logs, self_deploy (prod only), self_status, extension_reload |
| `telegram` | Yes (when ctx) | telegram_react, telegram_reply_to, telegram_pin, telegram_unpin, telegram_get_pinned, telegram_ask |

Selection algorithm:
1. At startup, `initPackEmbeddings()` embeds each non-`alwaysLoad` pack's description
2. Per message, the query embedding (from step 4 of processMessage) is compared against pack embeddings via cosine similarity
3. Packs above threshold (0.3) are included. `alwaysLoad` packs always included
4. If embedding generation fails at any point, all packs load (fail-open)

Tools follow the `InternalTool<T>` interface: `{ name, description, parameters: TSchema, execute }`. They are adapted to pi-agent-core's `AgentTool` via `createPiTool()`.

Telegram tools use a **side-effects pattern**: they write to a mutable `TelegramSideEffects` object (`reactToUser`, `replyToMessageId`, `suppressText`) which the bot handler reads after agent execution to apply Telegram-specific actions.

### Telegram integration (`apps/construct/src/telegram/`)

Grammy bot with long polling. Key behaviors:

- **Authorization** -- `ALLOWED_TELEGRAM_IDS` whitelist. Empty = allow all.
- **Per-chat queue** -- Messages from the same chat are serialized via `enqueue()` to prevent concurrent `processMessage()` calls on the same conversation (causes race conditions).
- **Reply-to threading** -- When multiple messages queue up (depth > 1), auto-sets `replyToMessageId` on responses so they thread correctly.
- **Typing indicator** -- Refreshed every 4s while the agent is processing.
- **Message chunking** -- Responses over 4000 chars are split into multiple messages.
- **HTML formatting** -- Markdown converted to Telegram HTML via `markdownToTelegramHtml()` (`format.ts`). Falls back to plain text if HTML parsing fails.
- **Reaction handling** -- User emoji reactions are converted to synthetic messages (`[User reacted with ... to ... message: "..."]`) and processed through the full agent pipeline.
- **Message ID tracking** -- Telegram message IDs are saved via `updateTelegramMessageId()` for reply-to references.

### Scheduler (`apps/construct/src/scheduler/index.ts`)

Croner-based reminder system. All schedules run through the full `processMessage()` pipeline with tool access, memory, and reasoning.

Mechanics:
- **Cron** -- Recurring schedules via cron expressions (with timezone support)
- **One-shot** -- `run_at` timestamp; auto-cancelled after firing. Past-due one-shots fire immediately.
- **Sync loop** -- Every 30s, polls the `schedules` table for new/cancelled entries and updates the in-memory job map
- **History tracking** -- Schedule outputs are saved to conversation history so the agent knows what was delivered

### CLI (`apps/construct/src/cli/index.ts`)

Citty CLI with four modes:

- **REPL** -- Interactive loop (`just cli`). Prompts `you>`, prints `construct>`.
- **One-shot** -- Single message: `just cli myinstance "message here"`
- **Tool invocation** -- Direct tool testing: `just cli myinstance --tool memory_recall --args '{"query":"..."}'`
- **Maintenance** -- `--reembed` (re-embed all memories with current model), `--backfill` (graph extraction + node embeddings + observer + reflector for all existing data)

All modes run migrations, create a DB connection, and go through `processMessage()` (except direct tool invocation which bypasses the agent).

### Extension system (`apps/construct/src/extensions/`)

User/agent-authored capabilities loaded from `EXTENSIONS_DIR`.

**Identity files** (root of extensions dir):
- `SOUL.md` -- Personality traits, values, communication style
- `IDENTITY.md` -- Agent metadata: name, creature type, pronouns
- `USER.md` -- Human context: name, location, preferences

**Skills** (`skills/` subdir):
- Markdown files with YAML frontmatter (`name`, `description`, optional `requires`)
- Body injected into context preamble when selected by embedding similarity
- Not tools -- they are instructions the agent follows

**Dynamic tools** (`tools/` subdir):
- TypeScript files loaded at runtime via jiti (no compile step)
- Single `.ts` file = standalone pack; directory of `.ts` files = grouped pack
- Export `{ name, description, parameters, execute }` (or factory function receiving `DynamicToolContext`)
- Optional `meta.requires` for dependency checking (env vars, secrets, binaries)
- `node_modules` symlinked from project root for import resolution

**Lifecycle**:
1. `initExtensions()` at startup: create dirs, load everything, compute embeddings
2. `extension_reload` tool: re-reads all files, rebuilds registry, recomputes embeddings
3. Selection per message: skills and dynamic packs filtered by embedding similarity (same query embedding)

**Registry** (`ExtensionRegistry`): singleton holding identity files, parsed skills, and loaded dynamic tool packs.

## Key files

| File | Role |
|------|------|
| `src/main.ts` | Entry point, boot sequence, graceful shutdown |
| `src/agent.ts` | `processMessage()` pipeline, `AgentResponse` type, pi-agent adaptation |
| `src/system-prompt.ts` | Base system prompt, identity injection, context preamble builder |
| `src/env.ts` | Zod-validated environment config |
| `src/logger.ts` | Logtape logging setup |
| `src/cli/index.ts` | CLI: REPL, one-shot, tool invoke, reembed, backfill |
| `src/telegram/bot.ts` | Grammy bot, authorization, queueing, reply threading, typing |
| `src/telegram/format.ts` | Markdown-to-Telegram-HTML conversion |
| `src/telegram/types.ts` | `TelegramContext`, `TelegramSideEffects` |
| `src/scheduler/index.ts` | Croner scheduler, static/agent execution, sync loop |
| `src/tools/packs.ts` | Tool pack definitions, embedding selection, `InternalTool` interface |
| `src/tools/core/` | Memory, schedule, secret, identity, usage tools |
| `src/tools/self/` | self_read, self_edit, self_test, self_logs, self_deploy, self_status, extension_reload |
| `src/tools/web/` | web_search (Tavily), web_read (fetch + parse) |
| `src/tools/telegram/` | react, reply_to, pin, unpin, get_pinned |
| `src/extensions/index.ts` | Extension registry, init/reload, skill/dynamic-tool selection |
| `src/extensions/loader.ts` | Skill parser, dynamic tool loader (jiti), requirement checker |
| `src/extensions/embeddings.ts` | Skill + dynamic pack embedding cache and selection |
| `src/extensions/secrets.ts` | Secrets table sync + builder |
| `src/memory.ts` | ConstructMemoryManager (extends Cairn with custom prompts, expires_at) |
| `src/db/schema.ts` | Construct-specific tables (extends CairnDatabase) |
| `src/db/queries.ts` | All DB query helpers |
| `src/db/migrate.ts` | Migration runner |

## Database tables

Construct's database extends Cairn's schema with three additional tables:

- `schedules` -- Cron/one-shot reminders (description, cron_expression/run_at, message, prompt, chat_id, active)
- `settings` -- Key-value store for app settings
- `secrets` -- Secrets store (key, value, source). `EXT_*` env vars synced on startup.
- `pending_asks` -- Interactive questions sent to users via Telegram (telegram_ask tool)

Plus all Cairn tables: `conversations`, `messages`, `memories`, `observations`, `graph_nodes`, `graph_edges`

## Integration points

- **@repo/cairn** -- Memory pipeline. `MemoryManager` used in `processMessage()` for context building (observations), memory recall (FTS5 + embeddings), and post-response observer/promoter/reflector. Graph extraction runs on promoted memories.
- **@repo/db** -- `createDb()` for database connection, migration runner.
- **pi-agent-core** -- LLM agent runtime. Construct wraps its `InternalTool` into pi-agent's `AgentTool` via `createPiTool()`.
- **OpenRouter** -- LLM inference (configurable model) and embedding generation.
- **Telegram** -- Grammy bot, long polling, message/reaction handling.
- **Tavily** -- Web search API (optional, gated by `TAVILY_API_KEY`).
- **Deck** -- Can browse Construct's memory graph by pointing at its database.

## Running

```bash
just dev               # Dev mode with file watching
just start myinstance  # Production (reads .env.construct)
just cli myinstance    # CLI mode
just cli myinstance --tool memory_recall --args '{"query":"test"}'
```
