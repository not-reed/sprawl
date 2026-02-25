# Scheduler / Reminders System

*Last updated: 2026-02-24 -- Initial documentation*

## Overview

The scheduler enables Construct to send messages at specific times or on recurring schedules. It uses Croner (a cron job library) to manage timed jobs and sends messages directly through the Telegram bot. Schedules are persisted in SQLite and survive restarts.

## Key Files

| File | Role |
|------|------|
| `src/scheduler/index.ts` | Scheduler lifecycle: start, register, fire, sync, stop |
| `src/tools/core/schedule.ts` | `schedule_create`, `schedule_list`, `schedule_cancel` tools |
| `src/db/queries.ts` | Schedule CRUD queries: `createSchedule`, `listSchedules`, `cancelSchedule`, `markScheduleRun` |

## How It Works

### Startup

`startScheduler(db, bot)` is called during main startup:

1. Loads all active schedules from the database
2. Registers a Croner job for each schedule
3. Sets up a 30-second polling interval to discover new schedules

### Schedule Types

| Type | Database Column | Behavior |
|------|----------------|----------|
| **Recurring** | `cron_expression` | Runs on a cron schedule indefinitely until cancelled |
| **One-shot** | `run_at` | Fires once at the specified time, then auto-cancels |

### Registration Logic

`registerJob(db, bot, schedule)`:

- **Recurring (cron_expression set)**: Creates a `new Cron(cronExpression, callback)` that fires the schedule on each cron tick
- **One-shot (run_at set)**:
  - If `run_at` is in the past, fires immediately and cancels
  - If `run_at` is in the future, creates a `new Cron(runAtDate, callback)` that fires once, then cancels and removes itself from the active jobs map

### Firing a Schedule

`fireSchedule(db, bot, schedule)`:

1. Sends the schedule's `message` to the schedule's `chat_id` via `bot.api.sendMessage()`
2. Updates `last_run_at` in the database via `markScheduleRun()`
3. Logs success or failure

Note: The scheduler sends raw messages directly, not through `processMessage()`. The scheduled message content is whatever was specified when the schedule was created.

### Sync Loop

Every 30 seconds, `syncSchedules(db, bot)`:

1. Loads all active schedules from the database
2. Registers jobs for any new schedules not yet in the `activeJobs` map
3. Stops and removes jobs for any schedules that have been cancelled (no longer in the active list)

This polling approach means new schedules created by the `schedule_create` tool are picked up within 30 seconds without requiring direct scheduler communication.

### Job Tracking

Active jobs are tracked in a module-level `Map<string, Cron>` keyed by schedule ID. This prevents duplicate registration and enables cleanup on cancellation.

### Shutdown

`stopScheduler()` stops all active Cron jobs and clears the map.

## Schedule Tools

The agent creates and manages schedules through three tools in the core pack:

### schedule_create

Parameters:
- `description` (required) -- Human-readable description
- `message` (required) -- Message text to send when triggered
- `cron_expression` (optional) -- Cron string (e.g., `"0 9 * * 1"` for Monday at 9am)
- `run_at` (optional) -- ISO 8601 timestamp for one-shot

The `chat_id` is automatically injected from the current conversation context. The agent never needs to specify it.

### schedule_list

Lists all schedules (active only by default), showing ID, status, description, and timing.

### schedule_cancel

Deactivates a schedule by setting `active = 0`. The sync loop will clean up the corresponding Croner job within 30 seconds.

## Database Schema

See [Database Layer](./database.md) for the full `schedules` table definition. Key fields:
- `cron_expression` and `run_at` are mutually exclusive (one should be set)
- `active` is an integer flag (1 = active, 0 = cancelled)
- `last_run_at` tracks the most recent execution

## Limitations

- Scheduled messages are sent as plain text, not processed through the agent. The agent does not "think" when a schedule fires -- it just delivers the pre-written message.
- Cron expressions use the system timezone, not the user's configured `TIMEZONE` (the agent should use the user's timezone when constructing the cron expression).
- The 30-second sync interval means there can be up to 30 seconds of delay between creating a schedule and it being registered.

## Related Documentation

- [Telegram Integration](./telegram.md) -- Bot used for message delivery
- [Tool System](./tools.md) -- Schedule tools in the core pack
- [Database Layer](./database.md) -- Schedule persistence
