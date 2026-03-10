---
title: Database Layer
description: SQLite schema and queries for Construct
---

# Database Layer

## Overview

Construct uses SQLite for all persistent storage, accessed through Kysely (a type-safe SQL query builder). The database connection and custom Kysely dialect are provided by `@repo/db`. Construct's schema extends `CairnDatabase` from `@repo/cairn` with app-specific tables.

## Key Files

| File                 | Role                                                     |
| -------------------- | -------------------------------------------------------- |
| `src/db/schema.ts`   | Construct-specific table types (extends `CairnDatabase`) |
| `src/db/queries.ts`  | All database query functions                             |
| `src/db/migrate.ts`  | Migration runner                                         |
| `src/db/migrations/` | Individual migration files (001-010)                     |

The `createDb()` function and custom Kysely dialect live in `@repo/db`. See [DB package docs](/db/) for details on the dialect and pragma configuration.

## Schema

Construct's database includes all Cairn tables plus four app-specific tables:

### Cairn Tables (from `@repo/cairn`)

| Table           | Purpose                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| `memories`      | Long-term facts, preferences, notes with FTS5 + embeddings                       |
| `memories_fts`  | FTS5 virtual table synced via triggers                                           |
| `conversations` | Groups messages by source + external ID. Includes observation watermark columns. |
| `messages`      | Individual messages (Construct extends with `telegram_message_id`)               |
| `observations`  | Compressed conversation summaries (Construct adds `expires_at`)                  |
| `graph_nodes`   | Entities extracted from memories                                                 |
| `graph_edges`   | Relationships between entities                                                   |
| `ai_usage`      | LLM token/cost tracking                                                          |

See [Cairn docs](/cairn/) for full Cairn schema details.

### Construct-Specific: messages (extended)

Construct's `messages` table extends Cairn's base with:

| Column                | Type               | Notes                                                     |
| --------------------- | ------------------ | --------------------------------------------------------- |
| `telegram_message_id` | integer (nullable) | Telegram message ID for cross-referencing (migration 004) |

### Construct-Specific: observations (extended)

Construct adds to Cairn's observations table:

| Column       | Type            | Notes                                                                    |
| ------------ | --------------- | ------------------------------------------------------------------------ |
| `expires_at` | text (nullable) | ISO datetime; expired observations filtered from context (migration 010) |

### schedules

Reminders and recurring tasks.

| Column            | Type            | Notes                                                                   |
| ----------------- | --------------- | ----------------------------------------------------------------------- |
| `id`              | text (PK)       | nanoid                                                                  |
| `description`     | text            | Human-readable description                                              |
| `cron_expression` | text (nullable) | Cron string for recurring schedules                                     |
| `run_at`          | text (nullable) | ISO 8601 datetime for one-shot schedules                                |
| `message`         | text            | NOT NULL; stores description as placeholder when using instruction mode |
| `prompt`          | text (nullable) | Agent instruction to execute when fired (migration 008)                 |
| `chat_id`         | text            | Telegram chat ID to deliver to                                          |
| `active`          | integer         | 1 = active, 0 = cancelled. Default 1                                    |
| `last_run_at`     | text (nullable) | Last execution timestamp                                                |
| `created_at`      | text            | Auto-set                                                                |

Index: `idx_schedules_active`

### settings

Key-value store for application settings.

| Column       | Type      | Notes         |
| ------------ | --------- | ------------- |
| `key`        | text (PK) | Setting name  |
| `value`      | text      | Setting value |
| `updated_at` | text      | Auto-set      |

### secrets

Stores API keys and tokens for extensions.

| Column       | Type      | Notes                                   |
| ------------ | --------- | --------------------------------------- |
| `key`        | text (PK) | Secret name                             |
| `value`      | text      | Secret value                            |
| `source`     | text      | `'agent'` or `'env'`. Default `'agent'` |
| `created_at` | text      | Auto-set                                |
| `updated_at` | text      | Auto-set                                |

### pending_asks

Tracks interactive questions sent to users via Telegram (used by `telegram_ask` tool).

| Column                | Type               | Notes                          |
| --------------------- | ------------------ | ------------------------------ |
| `id`                  | text (PK)          | nanoid                         |
| `conversation_id`     | text               | References conversations       |
| `chat_id`             | text               | Telegram chat ID               |
| `question`            | text               | The question text              |
| `options`             | text (nullable)    | JSON array of option strings   |
| `telegram_message_id` | integer (nullable) | Telegram message ID of the ask |
| `created_at`          | text               | Auto-set                       |
| `resolved_at`         | text (nullable)    | When the user responded        |
| `response`            | text (nullable)    | The user's response            |

## Migrations

Migrations use `@repo/db`'s migration runner. Each migration exports `up()` and optionally `down()`.

| Migration                        | Description                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `001-initial.ts`                 | Base tables: memories, conversations, messages, schedules, ai_usage, settings |
| `002-fts5-and-embeddings.ts`     | FTS5 virtual table, sync triggers, `embedding` column on memories             |
| `003-secrets.ts`                 | Creates the secrets table                                                     |
| `004-telegram-message-ids.ts`    | Adds `telegram_message_id` column and index to messages                       |
| `005-graph-memory.ts`            | Creates `graph_nodes` and `graph_edges` tables                                |
| `006-observational-memory.ts`    | Creates `observations` table, adds watermark columns to conversations         |
| `007-observation-promoted-at.ts` | Adds `promoted_at` column to observations (for promoter tracking)             |
| `008-schedule-prompt.ts`         | Adds `prompt` column to schedules (agent instruction mode)                    |
| `009-pending-asks.ts`            | Creates `pending_asks` table                                                  |
| `010-observation-expires-at.ts`  | Adds `expires_at` column to observations                                      |

Convention: **additive only** -- never drop tables or columns.

## Query Functions

All database queries are in `src/db/queries.ts`. Key functions:

### Memory Operations

Provided by `@repo/cairn/db/queries` -- see [Cairn docs](/cairn/).

### Conversation Operations

- **`getOrCreateConversation(db, source, externalId)`** -- Finds or creates conversation. Updates `updated_at`.
- **`getRecentMessages(db, conversationId, limit)`** -- Last N messages (chronological)
- **`saveMessage(db, message)`** -- Inserts a message with optional `telegram_message_id`
- **`updateTelegramMessageId(db, internalId, telegramMsgId)`** -- Associates Telegram message ID
- **`getMessageByTelegramId(db, conversationId, telegramMsgId)`** -- Lookup by Telegram ID

### Schedule Operations

- **`createSchedule(db, schedule)`** -- Inserts a schedule
- **`listSchedules(db, activeOnly)`** -- Lists schedules
- **`cancelSchedule(db, id)`** -- Sets `active = 0`
- **`markScheduleRun(db, id)`** -- Updates `last_run_at`

### Ask Operations

- **`getLastResolvedAsk(db, chatId)`** -- Returns the most recently resolved ask within the past 5 minutes (used by self-edit rejection detection)

### Usage, Settings

- **`trackUsage(db, usage)`** -- Insert usage record
- **`getUsageStats(db, opts?)`** -- Aggregated usage stats
- **`getSetting(db, key)`** / **`setSetting(db, key, value)`** -- Settings CRUD

## ID Generation

All entity IDs use `nanoid()` (21-character URL-safe string).
