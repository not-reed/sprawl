# Scheduler / Reminders System

*Last updated: 2026-03-01 -- Added agent-prompt mode, dedup logic, corrected timezone and firing behavior*

## Overview

The scheduler enables Construct to fire actions at specific times or on recurring schedules. It supports two execution modes: **static messages** (deliver a pre-written string) and **agent prompts** (run a full `processMessage()` cycle with tool access, memory, and reasoning). It uses Croner for timed jobs, persists schedules in SQLite, and survives restarts.

## Key Files

| File | Role |
|------|------|
| `src/scheduler/index.ts` | Scheduler lifecycle: start, register, fire, sync, stop |
| `src/tools/core/schedule.ts` | `schedule_create`, `schedule_list`, `schedule_cancel` tools + dedup logic |
| `src/db/schema.ts` | `ScheduleTable` type (includes `prompt` column) |
| `src/db/queries.ts` | Schedule CRUD queries: `createSchedule`, `listSchedules`, `cancelSchedule`, `markScheduleRun` |

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

### Execution Modes

Each schedule has a `message` field and an optional `prompt` field. The `prompt` field controls which execution path is used:

| Mode | Field Set | What Happens |
|------|-----------|--------------|
| **Static** | `message` only (`prompt` is null) | `fireStaticSchedule()` -- sends the message string directly via Telegram |
| **Agent** | `prompt` is set | `fireAgentSchedule()` -- runs the prompt through `processMessage()` with full agent capabilities |

This branching happens in `fireSchedule()` (line 70 of `scheduler/index.ts`):

```typescript
if (schedule.prompt) {
  await fireAgentSchedule(db, bot, schedule)
} else {
  await fireStaticSchedule(db, bot, schedule)
}
```

#### Static Mode (`fireStaticSchedule`)

1. Sends `schedule.message` to `schedule.chat_id` via `bot.api.sendMessage()` as plain text
2. Marks the schedule as run via `markScheduleRun()`
3. Saves the message to conversation history so the agent knows the reminder was delivered

#### Agent-Prompt Mode (`fireAgentSchedule`)

1. Calls `processMessage(db, schedule.prompt, { source: 'scheduler', ... })` -- this is the same full agent pipeline used for Telegram and CLI messages
2. The agent gets its system prompt, memory context, tool packs (selected via embeddings), conversation history, and the prompt as its input message
3. The agent can use any tools it would normally have access to: memory, web search, self-edit, schedule management, etc.
4. If the agent produces a non-empty text response, it is sent to Telegram (formatted as HTML via `markdownToTelegramHtml`, with a plain-text fallback)
5. If the response is empty, the schedule fires silently (logged but nothing sent)
6. The response is saved to conversation history with a `[Scheduled: ...]` prefix

This makes agent-prompt schedules useful for:
- **Conditional notifications**: "Check if BTC is above $100k and only notify me if it is"
- **Background tasks**: "Summarize my unread memories every Sunday"
- **Periodic reasoning**: "Review my goals and suggest next steps"
- Any task that benefits from tool access, memory recall, or LLM reasoning

### Registration Logic

`registerJob(db, bot, schedule, timezone)`:

- **Recurring (cron_expression set)**: Creates a `new Cron(cronExpression, { timezone }, callback)` that fires the schedule on each cron tick
- **One-shot (run_at set)**:
  - Creates a `new Cron(runAtDate, { timezone }, callback)` that fires once, then cancels and removes itself from the active jobs map
  - If `nextRun()` returns null (time is in the past), fires immediately and cancels

Both types pass the user's configured `TIMEZONE` to Croner, so cron expressions and `run_at` times are interpreted in the user's local timezone.

### Sync Loop

Every 30 seconds, `syncSchedules(db, bot, timezone)`:

1. Loads all active schedules from the database
2. Registers jobs for any new schedules not yet in the `activeJobs` map
3. Stops and removes jobs for any schedules that have been cancelled (no longer in the active list)

This polling approach means new schedules created by the `schedule_create` tool are picked up within 30 seconds without requiring direct scheduler communication.

### Job Tracking

Active jobs are tracked in a module-level `Map<string, Cron>` keyed by schedule ID. This prevents duplicate registration and enables cleanup on cancellation.

### Shutdown

`stopScheduler()` stops all active Cron jobs, clears the sync interval, and empties the map.

## Schedule Tools

The agent creates and manages schedules through three tools in the core pack (`src/tools/core/schedule.ts`):

### schedule_create

Parameters:
- `description` (required) -- Human-readable description (e.g. "Dentist appointment reminder")
- `message` (optional) -- Static message to send when triggered. Required unless `prompt` is provided.
- `prompt` (optional) -- Agent prompt to run when triggered, with full tool access. Mutually exclusive with `message`.
- `cron_expression` (optional) -- Cron string (e.g., `"0 9 * * 1"` for Monday at 9am)
- `run_at` (optional) -- Datetime in user's local timezone, without Z or offset (e.g. `"2025-03-05T09:00:00"`)

Validation:
- Must provide either `cron_expression` or `run_at` (timing)
- Must provide either `message` or `prompt` (content), but not both
- `run_at` values have timezone offsets stripped (`stripTimezoneOffset()`) so they're treated as local time
- `chat_id` is automatically injected from the current conversation context

When `prompt` is used, the `message` column (which is NOT NULL in the schema) is filled with the `description` as a fallback.

#### Deduplication

`schedule_create` performs two-pass dedup to prevent the agent from creating duplicate schedules:

1. **Fast pass (Levenshtein)**: For schedules matching the same chat, mode (static vs prompt), and timing, checks content similarity using Levenshtein distance (threshold 0.75). Compares `message`/`prompt` content and `description` separately.

2. **Slow pass (embedding similarity)**: If the fast pass finds no match but there are time-matching candidates, generates embeddings for the new description and all candidate descriptions, then checks cosine similarity (threshold 0.7).

If a duplicate is found, the tool returns the existing schedule instead of creating a new one, with a `deduplicated: true` flag in the details.

### schedule_list

Lists all schedules (active only by default), showing ID, status, description, and timing. Agent-prompt schedules are marked with an `[agent]` badge in the output.

Parameters:
- `active_only` (optional, default: true) -- Whether to filter to active schedules only

### schedule_cancel

Deactivates a schedule by setting `active = 0`. The sync loop will clean up the corresponding Croner job within 30 seconds.

Parameters:
- `id` (required) -- The schedule ID to cancel

## Database Schema

The `schedules` table (`src/db/schema.ts`):

| Column | Type | Description |
|--------|------|-------------|
| `id` | string | Primary key |
| `description` | string | Human-readable description |
| `cron_expression` | string or null | Cron pattern for recurring schedules |
| `run_at` | string or null | ISO datetime for one-shot schedules |
| `message` | string | Static message content (also used as fallback for prompt mode) |
| `prompt` | string or null | Agent prompt for agent-executed schedules |
| `chat_id` | string | Telegram chat to deliver to |
| `active` | integer (default 1) | 1 = active, 0 = cancelled |
| `last_run_at` | string or null | Timestamp of most recent execution |
| `created_at` | string (auto) | Creation timestamp |

Key constraints:
- `cron_expression` and `run_at` are mutually exclusive (one should be set)
- `message` and `prompt` represent two execution modes; `prompt` being non-null triggers agent mode
- `message` is NOT NULL -- when in prompt mode, it stores the description as a placeholder

See [Database Layer](./database.md) for the full schema.

## Data Flow

```mermaid
graph TD
    AgentTool["schedule_create tool"] -->|inserts row| DB[(schedules table)]
    DB -->|30s poll| SyncLoop["syncSchedules()"]
    SyncLoop -->|new schedule| Register["registerJob()"]
    Register -->|creates| CronJob["Croner job"]
    CronJob -->|timer fires| Fire["fireSchedule()"]
    Fire -->|prompt is null| Static["fireStaticSchedule()"]
    Fire -->|prompt is set| AgentFire["fireAgentSchedule()"]
    Static -->|bot.api.sendMessage| Telegram["Telegram chat"]
    AgentFire -->|processMessage()| AgentPipeline["Full agent pipeline"]
    AgentPipeline -->|tools, memory, reasoning| AgentResponse["Agent response"]
    AgentResponse -->|formatted HTML| Telegram
    Static -->|saveMessage| History[(conversation history)]
    AgentResponse -->|saveMessage| History
```

## Limitations

- **Sync delay**: The 30-second sync interval means there can be up to 30 seconds of delay between creating a schedule and it being registered.
- **No response streaming**: Agent-prompt schedule responses are sent as a single message after the agent finishes, not streamed.
- **Agent-prompt cost**: Each agent-prompt firing incurs a full LLM call (with tool pack selection, embedding generation, memory recall, etc.), so frequent cron schedules with prompts can accumulate cost.
- **Error handling**: If `processMessage()` throws during an agent-prompt schedule, the error is logged but no message is sent to the user. The schedule is not retried.

## Related Documentation

- [Agent Pipeline](./agent.md) -- `processMessage()` used by agent-prompt mode
- [Telegram Integration](./telegram.md) -- Bot used for message delivery
- [Tool System](./tools.md) -- Schedule tools in the core pack
- [Database Layer](./database.md) -- Schedule persistence
- [Memory System](./memory.md) -- Memory context available to agent-prompt schedules
