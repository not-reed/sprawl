# System Prompt Construction

*Last updated: 2026-02-24 -- Initial documentation*

## Overview

The system prompt is split into two layers for prompt caching efficiency:

1. **Static system prompt** -- Base rules + identity files (SOUL.md, IDENTITY.md, USER.md). Cached and reused across requests.
2. **Dynamic context preamble** -- Prepended to each user message. Contains date/time, memories, skills, and reply context.

This separation means the LLM can cache the system prompt tokens and only process the changing preamble as new input.

## Key Files

| File | Role |
|------|------|
| `src/system-prompt.ts` | `getSystemPrompt()`, `buildContextPreamble()`, `invalidateSystemPromptCache()`, `formatNow()` |

## Static System Prompt

`getSystemPrompt(identity?)` builds the full system prompt by concatenating:

### BASE_SYSTEM_PROMPT

The hardcoded base prompt that defines:

- **Role**: "You are a personal companion"
- **Rules**:
  - Be concise (Telegram context)
  - Proactively store memories
  - Search broadly when recalling
  - Confirm time/message before creating reminders
  - Explain what/why before self-editing
  - Never deploy without passing tests
  - Never edit files outside `src/`, `cli/`, or `extensions/`
- **Telegram interactions**: How to use telegram tools, message ID format
- **Proactive communication**: When to add context beyond the bare minimum
- **Identity files**: How to use identity_read/identity_update tools
- **Extensions**: How tools and skills work, when to call extension_reload

### Identity Sections

If identity files are loaded, they are appended as sections:

```
## Identity
<content of IDENTITY.md>

## User
<content of USER.md>

## Soul
<content of SOUL.md>
```

Note the order: Identity, User, Soul. The Soul section (personality) comes last so it has the strongest influence on the model's behavior.

### Caching

The system prompt is cached in module-level variables. The cache key is a pipe-delimited concatenation of all three identity file contents. `invalidateSystemPromptCache()` clears the cache (called by `identity_update` and `extension_reload`).

## Dynamic Context Preamble

`buildContextPreamble(context)` creates a text block prepended to each user message. It contains:

### 1. Context Header

```
[Context: Monday, February 24, 2026 at 3:15 PM (America/New_York) | telegram]
```

Includes the current date/time formatted using `Intl.DateTimeFormat` in the configured timezone, the message source, and a DEV MODE flag if applicable.

### 2. Dev Mode Warning

```
[Running in development -- hot reload is active, self_deploy is disabled]
```

Only present when `NODE_ENV=development`.

### 3. Recent Memories

```
[Recent memories -- use these for context, pattern recognition, and continuity]
- (preference) User prefers dark mode
- (fact) User works at Acme Corp
```

The 10 most recent memories, regardless of relevance. Gives the agent temporal continuity.

### 4. Relevant Memories

```
[Potentially relevant memories]
- (note) Meeting with Bob about the API redesign (87% match)
```

Up to 5 semantically relevant memories with match percentage. Deduped against recent memories.

### 5. Active Skills

```
[Active skills -- follow these instructions when relevant]

### daily-standup
When the user asks for a standup...
```

Up to 3 skills selected by embedding similarity (threshold 0.35).

### 6. Reply Context

```
[Replying to: "what was that thing you mentioned yesterday?"]
```

When the user replies to a specific message in Telegram, the original message text (truncated to 300 chars) is included.

## Date/Time Formatting

`formatNow(timezone)` uses the built-in `Intl` API (no dependencies):

```typescript
new Date().toLocaleString('en-US', {
  timeZone: timezone,
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})
```

Output example: `Monday, February 24, 2026 at 3:15 PM`

## Full Prompt Assembly

The complete prompt the LLM sees:

```
[System prompt]
  BASE_SYSTEM_PROMPT
  ## Identity (if loaded)
  ## User (if loaded)
  ## Soul (if loaded)

[User message]
  [Context: Monday, February 24, 2026 at 3:15 PM (America/New_York) | telegram]
  [Recent memories...]
  [Relevant memories...]
  [Active skills...]
  [Reply context...]

  <actual user message>
```

The preamble is prepended directly to the user's message text (no separator).

## Related Documentation

- [Agent System](./agent.md) -- How the prompt is used in processMessage()
- [Extension System](./extensions.md) -- Identity files and skill injection
- [Environment Configuration](./../guides/environment.md) -- TIMEZONE setting
