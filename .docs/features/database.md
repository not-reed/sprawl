# Database Layer

*Last updated: 2026-02-26 -- Added graph memory and observational memory tables*

## Overview

Construct uses SQLite for all persistent storage, accessed through Kysely (a type-safe SQL query builder). Instead of the common `better-sqlite3` native addon, it uses Node.js built-in `node:sqlite` (`DatabaseSync`) with a custom Kysely dialect. This eliminates native compilation requirements, which is important for ARM deployment targets.

## Key Files

| File | Role |
|------|------|
| `src/db/index.ts` | Custom Kysely dialect for `node:sqlite`, `createDb()` function |
| `src/db/schema.ts` | TypeScript type definitions for all tables |
| `src/db/queries.ts` | All database query functions (memories, conversations, messages, schedules, usage, settings) |
| `src/db/migrate.ts` | Migration runner using Kysely's `FileMigrationProvider` |
| `src/db/migrations/` | Individual migration files |

## Custom Kysely Dialect

`src/db/index.ts` implements three classes to bridge `node:sqlite` to Kysely:

- **`NodeSqliteDialect`** -- Implements `Dialect`, creates the driver, query compiler (SQLite), adapter, and introspector
- **`NodeSqliteDriver`** -- Implements `Driver`, manages connection lifecycle and transactions
- **`NodeSqliteConnection`** -- Implements `DatabaseConnection`, executes queries by detecting SELECT/PRAGMA/WITH (returning rows) vs. other statements (returning affected row counts)

`createDb()` opens the database with pragmas:
- `PRAGMA journal_mode = WAL` -- Write-Ahead Logging for concurrent reads/writes
- `PRAGMA busy_timeout = 5000` -- Wait up to 5 seconds on lock contention
- `PRAGMA foreign_keys = ON` -- Enforce foreign key constraints

## Schema

Ten tables are defined in `src/db/schema.ts`:

### memories

Stores long-term memories with full-text search and embedding support.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text (PK) | nanoid |
| `content` | text | The memory content |
| `category` | text | Default `'general'`. Options: general, preference, fact, reminder, note |
| `tags` | text (nullable) | JSON array of keyword tags |
| `source` | text | Default `'user'` |
| `embedding` | text (nullable) | JSON-serialized embedding vector (added in migration 002) |
| `created_at` | text | ISO 8601 datetime, auto-set |
| `updated_at` | text | ISO 8601 datetime, auto-set |
| `archived_at` | text (nullable) | Set when "forgotten" (soft delete) |

Indexes: `idx_memories_category`, `idx_memories_archived`

### memories_fts (FTS5 virtual table)

Full-text search index on memories, synced via triggers.

| Column | Indexed | Source |
|--------|:---:|--------|
| `id` | No (UNINDEXED) | memories.id |
| `content` | Yes | memories.content |
| `tags` | Yes | memories.tags |
| `category` | No (UNINDEXED) | memories.category |

Three triggers keep it in sync: `memories_ai` (insert), `memories_ad` (delete), `memories_au` (update).

### conversations

Groups messages by source and external identifier.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text (PK) | nanoid |
| `source` | text | `'telegram'` or `'cli'` |
| `external_id` | text (nullable) | Telegram chat ID, or `'cli'` |
| `created_at` | text | Auto-set |
| `updated_at` | text | Auto-set, updated on each message |

Index: `idx_conversations_external`

### messages

Individual messages within conversations.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text (PK) | nanoid |
| `conversation_id` | text (FK) | References conversations.id |
| `role` | text | `'user'` or `'assistant'` |
| `content` | text | Message text |
| `tool_calls` | text (nullable) | JSON array of `{name, args, result}` |
| `telegram_message_id` | integer (nullable) | Telegram message ID for cross-referencing (added in migration 004) |
| `created_at` | text | Auto-set |

Indexes: `idx_messages_conversation`, `idx_messages_telegram_message_id`

### schedules

Reminders and recurring tasks.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text (PK) | nanoid |
| `description` | text | Human-readable description |
| `cron_expression` | text (nullable) | Cron string for recurring schedules |
| `run_at` | text (nullable) | ISO 8601 datetime for one-shot schedules |
| `message` | text | Message to send when triggered |
| `chat_id` | text | Telegram chat ID to send to |
| `active` | integer | 1 = active, 0 = cancelled. Default 1 |
| `last_run_at` | text (nullable) | Last execution timestamp |
| `created_at` | text | Auto-set |

Index: `idx_schedules_active`

### ai_usage

Tracks LLM API usage for cost monitoring.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text (PK) | nanoid |
| `model` | text | Model identifier (e.g., `google/gemini-3-flash-preview`) |
| `input_tokens` | integer (nullable) | Input token count |
| `output_tokens` | integer (nullable) | Output token count |
| `cost_usd` | real (nullable) | Cost in USD |
| `source` | text | `'telegram'` or `'cli'` |
| `created_at` | text | Auto-set |

### settings

Key-value store for application settings.

| Column | Type | Notes |
|--------|------|-------|
| `key` | text (PK) | Setting name |
| `value` | text | Setting value |
| `updated_at` | text | Auto-set |

### secrets

Stores API keys and tokens for extensions.

| Column | Type | Notes |
|--------|------|-------|
| `key` | text (PK) | Secret name |
| `value` | text | Secret value |
| `source` | text | `'agent'` or `'env'`. Default `'agent'` |
| `created_at` | text | Auto-set |
| `updated_at` | text | Auto-set |

### graph_nodes

Entity nodes extracted from memories by the graph memory system. See [Memory System](./memory.md) for details.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text (PK) | nanoid |
| `name` | text | Canonical (lowercased, trimmed) |
| `display_name` | text | Original casing |
| `node_type` | text | `person`, `place`, `concept`, `event`, or `entity`. Default `entity` |
| `description` | text (nullable) | Short description from extraction |
| `embedding` | text (nullable) | Reserved for future node embeddings |
| `created_at` | text | Auto-set |
| `updated_at` | text | Auto-set |

Unique index: `idx_gn_name_type` on `(name, node_type)`

### graph_edges

Relationships between graph nodes, linked back to source memories.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text (PK) | nanoid |
| `source_id` | text (FK) | References `graph_nodes.id` |
| `target_id` | text (FK) | References `graph_nodes.id` |
| `relation` | text | Short verb phrase, lowercased |
| `weight` | real | Default 1.0, incremented on repeated mention |
| `properties` | text (nullable) | JSON for extensible metadata |
| `memory_id` | text (nullable, FK) | References `memories.id` |
| `created_at` | text | Auto-set |
| `updated_at` | text | Auto-set |

Indexes: `idx_ge_source`, `idx_ge_target`, `idx_ge_unique` (unique on `source_id, target_id, relation`)

### observations

Compressed conversation summaries produced by the observational memory system. See [Memory System](./memory.md) for details.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text (PK) | nanoid |
| `conversation_id` | text (FK) | References `conversations.id` |
| `content` | text | The observation text |
| `priority` | text | `high`, `medium`, or `low`. Default `medium` |
| `observation_date` | text | Date context for the observation |
| `source_message_ids` | text (nullable) | JSON array of message IDs |
| `token_count` | integer (nullable) | Estimated token count |
| `generation` | integer | 0 = observer, 1+ = reflector rounds. Default 0 |
| `superseded_at` | text (nullable) | Set when replaced by reflector |
| `created_at` | text | Auto-set |

Indexes: `idx_obs_conv` (conversation_id), `idx_obs_active` (conversation_id, superseded_at)

Note: Migration 006 also adds `observed_up_to_message_id` (text, nullable) and `observation_token_count` (integer, default 0) to the `conversations` table for watermark tracking.

## Migrations

Migrations use Kysely's `FileMigrationProvider` which scans `src/db/migrations/` for files. Each migration exports `up()` and `down()` functions.

| Migration | Description |
|-----------|-------------|
| `001-initial.ts` | Creates all base tables (memories, conversations, messages, schedules, ai_usage, settings) and indexes |
| `002-fts5-and-embeddings.ts` | Creates FTS5 virtual table, sync triggers, adds `embedding` column to memories |
| `003-secrets.ts` | Creates the secrets table |
| `004-telegram-message-ids.ts` | Adds `telegram_message_id` column and index to messages |
| `005-graph-memory.ts` | Creates `graph_nodes` and `graph_edges` tables with indexes and foreign keys |
| `006-observational-memory.ts` | Creates `observations` table, adds watermark columns to `conversations` |

Migrations are run via `runMigrations()` which is called both at startup and by the `npm run db:migrate` script. The convention is **additive only** -- never drop tables or columns.

## Query Functions

All database queries are in `src/db/queries.ts`. Key functions:

### Memory Operations

- **`storeMemory(db, memory)`** -- Inserts a memory with nanoid, returns the full record
- **`updateMemoryEmbedding(db, id, embedding)`** -- Updates a memory's embedding (JSON-serialized)
- **`recallMemories(db, query, opts?)`** -- Hybrid search: FTS5 -> embedding cosine similarity -> LIKE fallback. Results are merged and deduplicated by ID
- **`getRecentMemories(db, limit)`** -- Returns the N most recent non-archived memories
- **`forgetMemory(db, id)`** -- Soft-deletes by setting `archived_at`
- **`searchMemoriesForForget(db, query)`** -- Searches for forget candidates

### Conversation Operations

- **`getOrCreateConversation(db, source, externalId)`** -- Finds existing conversation by `(source, external_id)` or creates one. Updates `updated_at` on access.
- **`getRecentMessages(db, conversationId, limit)`** -- Returns last N messages in chronological order (fetched DESC then reversed)
- **`saveMessage(db, message)`** -- Inserts a message, returns its nanoid
- **`updateTelegramMessageId(db, internalId, telegramMsgId)`** -- Associates a Telegram message ID with an internal message
- **`getMessageByTelegramId(db, conversationId, telegramMsgId)`** -- Looks up a message by its Telegram message ID

### Schedule Operations

- **`createSchedule(db, schedule)`** -- Inserts a schedule, returns the full record
- **`listSchedules(db, activeOnly)`** -- Lists schedules, optionally filtered to active only
- **`cancelSchedule(db, id)`** -- Sets `active = 0`
- **`markScheduleRun(db, id)`** -- Updates `last_run_at` to now

### Usage Tracking

- **`trackUsage(db, usage)`** -- Inserts a usage record
- **`getUsageStats(db, opts?)`** -- Aggregates usage: total cost, tokens, message count, plus per-day breakdown. Supports day range and source filters.

### Settings

- **`getSetting(db, key)`** -- Returns a setting value or null
- **`setSetting(db, key, value)`** -- Upserts a setting

## ID Generation

All entity IDs use `nanoid()` (21-character URL-safe string) rather than auto-incrementing integers. This avoids ID collision concerns and works well with distributed systems.

## Related Documentation

- [Architecture Overview](./../architecture/overview.md) -- How the database fits into the system
- [Memory System](./memory.md) -- Graph memory, observational memory, and declarative memory details
- [Tool System](./tools.md) -- Tools that interact with the database
- [Extension System](./extensions.md) -- Secrets table usage
