---
title: Scheduler / Reminders
description: Croner scheduling with agent-driven execution
---

# Scheduler / Reminders System

## Overview

The scheduler enables Construct to fire actions at specific times or on recurring schedules. All schedules run through the full `processMessage()` pipeline with tool access, memory, and reasoning. It uses Croner for timed jobs, persists schedules in SQLite, and survives restarts.

## Key Files

| File | Role |
|------|------|
| `src/scheduler/index.ts` | Scheduler lifecycle: start, register, fire, sync, stop |
| `src/tools/core/schedule.ts` | `schedule_create`, `schedule_list`, `schedule_cancel` tools + dedup logic |
| `src/db/schema.ts` | `ScheduleTable` type |
| `src/db/queries.ts` | Schedule CRUD queries |

## How It Works

### Startup

`startScheduler(db, bot, timezone)` is called during main startup (`src/main.ts`):

1. Loads all active schedules from the database
2. Registers a Croner job for each schedule, passing the user's configured `TIMEZONE`
3. Sets up a 30-second polling interval to discover new schedules

### Schedule Timing Types

| Type | Database Column | Behavior |
|------|----------------|----------|
| **Recurring** | `cron_expression` | Runs on a cron schedule indefinitely until cancelled |
| **One-shot** | `run_at` | Fires once at the specified time, then auto-cancels |

### Execution

When a schedule fires, `fireSchedule()` routes it through `fireAgentSchedule()`:

1. The instruction is read from `schedule.prompt` (falling back to `schedule.message` for legacy schedules)
2. The instruction is framed with context: `[Scheduled task "description" is firing now. Execute the instruction -- do not re-schedule it.]`
3. `processMessage()` is called with the framed instruction, `source: 'scheduler'`, and the schedule's `chat_id`
4. The agent gets its full system prompt, memory context, tool packs, conversation history
5. If the agent produces a non-empty response, it's sent to Telegram (HTML formatted, with plain-text fallback)
6. The response is saved to the user's Telegram conversation history with a `[Scheduled: ...]` prefix

This makes schedules useful for:
- **Conditional notifications**: "Check if BTC is above $100k and only notify me if it is"
- **Background tasks**: "Summarize my unread memories every Sunday"
- **Reminders with context**: "Remind the user about their dentist appointment and check if they need directions"
- Any task that benefits from tool access, memory recall, or LLM reasoning

### Registration Logic

`registerJob(db, bot, schedule, timezone)`:

- **Recurring (cron_expression set)**: Creates a `new Cron(cronExpression, { timezone }, callback)` that fires on each cron tick
- **One-shot (run_at set)**:
  - Creates a `new Cron(runAtDate, { timezone }, callback)` that fires once, then cancels and removes itself
  - If `nextRun()` returns null (time is in the past), fires immediately and cancels

Both types pass the user's configured `TIMEZONE` to Croner, so cron expressions and `run_at` times are interpreted in the user's local timezone.

### Sync Loop

Every 30 seconds, `syncSchedules(db, bot, timezone)`:

1. Loads all active schedules from the database
2. Registers jobs for any new schedules not yet in the `activeJobs` map
3. Stops and removes jobs for any schedules that have been cancelled

This polling approach means new schedules created by `schedule_create` are picked up within 30 seconds.

### Shutdown

`stopScheduler()` stops all active Cron jobs, clears the sync interval, and empties the map.

## Schedule Tools

The agent creates and manages schedules through three tools in the core pack (`src/tools/core/schedule.ts`):

### schedule_create

Parameters:
- `description` (required) -- Human-readable description (e.g. "Dentist appointment reminder")
- `instruction` (required) -- What the agent should do when the schedule fires. The agent runs this with full context and tool access.
- `cron_expression` (optional) -- Cron string (e.g., `"0 9 * * 1"` for Monday at 9am)
- `run_at` (optional) -- Datetime in user's local timezone, without Z or offset (e.g. `"2025-03-05T09:00:00"`)

Validation:
- Must provide either `cron_expression` or `run_at` (timing)
- `run_at` values have timezone offsets stripped so they're treated as local time
- `chat_id` is automatically injected from the current conversation context

The `message` column (NOT NULL) is filled with the `description` as a placeholder. The `prompt` column stores the `instruction`.

#### Deduplication

`schedule_create` performs two-pass dedup to prevent duplicate schedules:

1. **Fast pass (Levenshtein)**: For schedules matching the same chat and timing, checks content similarity using Levenshtein distance (threshold 0.75). Compares instruction content and description.

2. **Slow pass (embedding similarity)**: If the fast pass finds no match but there are time-matching candidates, generates embeddings and checks cosine similarity (threshold 0.7).

If a duplicate is found, the existing schedule is returned with `deduplicated: true`.

### schedule_list

Lists all schedules (active only by default), showing ID, status, description, and timing. Agent schedules are marked with an `[agent]` badge.

### schedule_cancel

Deactivates a schedule by ID. The sync loop cleans up the Croner job within 30 seconds.

## Database Schema

See [Database Layer](/construct/database/) for the full `schedules` table schema.

## Data Flow

```mermaid
graph TD
    AgentTool["schedule_create tool"] -->|inserts row| DB[(schedules table)]
    DB -->|30s poll| SyncLoop["syncSchedules()"]
    SyncLoop -->|new schedule| Register["registerJob()"]
    Register -->|creates| CronJob["Croner job"]
    CronJob -->|timer fires| Fire["fireSchedule()"]
    Fire -->|processMessage()| AgentPipeline["Full agent pipeline"]
    AgentPipeline -->|tools, memory, reasoning| AgentResponse["Agent response"]
    AgentResponse -->|formatted HTML| Telegram["Telegram chat"]
    AgentResponse -->|saveMessage| History[(conversation history)]
```

## Limitations

- **Sync delay**: Up to 30 seconds between creating a schedule and it being registered.
- **No response streaming**: Schedule responses are sent as a single message after the agent finishes.
- **Cost**: Each schedule firing incurs a full LLM call (tool pack selection, embedding generation, memory recall, etc.).
- **Error handling**: If `processMessage()` throws, the error is logged but no message is sent to the user. No retries.
