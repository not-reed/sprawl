# Construct

AI braindump companion. Telegram bot + CLI + scheduler backed by memory pipeline.

## Key Files

- `src/agent.ts` -- `processMessage()` orchestration: continuation loop, usage accumulation, persistence
- `src/agent-context.ts` -- Context assembly: conversation, observations, memory recall, skill selection
- `src/agent-turn.ts` -- Single LLM turn: tool bundling, history rehydration, streaming, usage tracking
- `src/agent-post-turn.ts` -- Async memory pipeline: skill graph edges, pipeline enqueue, skill extraction
- `src/agent-types.ts` -- Shared types: `AgentResponse`, `ProcessMessageOpts`, `AssembledContext`, `TurnResult`
- `src/completion-check.ts` -- Continuation heuristics: detects incomplete tool chains or empty responses
- `src/main.ts` -- Boot sequence: migrations, DB, extensions, pack embeddings, scheduler, Telegram
- `src/system-prompt.ts` -- System prompt construction + identity file injection
- `src/tools/packs.ts` -- `InternalTool` interface, `ToolContext`, semantic tool pack selection
- `src/memory.ts` -- `ConstructMemoryManager` subclass with construct-specific observer/reflector prompts
- `src/env.ts` -- Zod-validated env vars
- `src/errors.ts` -- `ToolError`, `ExtensionError`, `AgentError`, `ConfigError`

## Architecture

```
Telegram/CLI message
  → processMessage() (agent.ts)
    → assembleContext() (agent-context.ts)
      → getOrCreateConversation
      → ConstructMemoryManager.buildContext (observations + active messages)
      → recallMemories (FTS + embeddings + graph)
      → selectAndRetrieveSkillInstructions
    → executeTurn() (agent-turn.ts) [may loop via continuation check]
      → selectAndCreateTools (semantic pack selection via query embedding)
      → Agent.prompt() (pi-agent-core)
    → persistTurn (save assistant message + usage)
    → runPostTurn() (agent-post-turn.ts) — fire-and-forget
      → skill graph edges
      → pipeline enqueue (observer → promoter → reflector → graph)
      → skill extraction + nudge
```

## Directory Structure

```
src/
├── agent.ts              # processMessage() orchestration + continuation loop
├── agent-context.ts      # Context assembly: conversation, memories, skills
├── agent-turn.ts         # Single LLM turn: tools, history, streaming
├── agent-post-turn.ts    # Async memory pipeline + skill graph edges
├── agent-types.ts        # Shared types
├── completion-check.ts   # Continuation heuristics
├── system-prompt.ts      # System prompt + identity file injection
├── memory.ts             # ConstructMemoryManager subclass
├── main.ts               # Boot sequence
├── env.ts                # Zod env validation
├── errors.ts             # ToolError, ExtensionError, AgentError, ConfigError
├── logger.ts             # Logtape logging
├── cli/index.ts          # Citty CLI (REPL, one-shot, tool invocation)
├── db/
│   ├── schema.ts         # Construct + Cairn table types (intersection)
│   ├── queries.ts        # Query helpers
│   ├── migrate.ts        # Migration runner
│   └── migrations/       # 001-010
├── tools/
│   ├── packs.ts          # Tool pack selection + InternalTool type
│   ├── core/             # Always-loaded: memory, schedule, secrets, identity, usage
│   │   └── *-handlers.ts # Tool execution handlers (separated from definitions)
│   ├── self/             # Self-modification: read, edit, test, logs, deploy, status
│   │   └── *-handlers.ts
│   ├── web/              # Web search (Tavily) + web read
│   └── telegram/         # React, reply-to, pin/unpin, get-pinned, ask
│       └── *-handlers.ts
├── telegram/
│   ├── bot.ts            # Bot factory (Grammy instance creation)
│   ├── bot-handlers.ts   # Message/callback/reaction handlers
│   ├── bot-queue.ts      # Per-chat queue manager + typing indicator
│   ├── bot-send.ts       # Reply/ask message sending helpers
│   └── format.ts         # Markdown → Telegram HTML
├── scheduler/index.ts    # Croner reminder daemon
└── extensions/
    ├── loader.ts         # Dynamic tool/skill loader (jiti)
    ├── embeddings.ts     # Extension pack embeddings
    └── secrets.ts        # Secrets table + EXT_* sync
```

## Tools vs Skills

**Tools** (in `src/tools/`) = capability primitives that enable actions otherwise impossible:

- `memory_store`, `memory_recall` — persistence without tools, no memory
- `shell_tool` — OS access
- `web_search`, `web_read` — network queries

Tools are always available (8 built-in primitives loaded unconditionally). They don't execute themselves — they're called by the agent.

**Skills** (in `extensions/skills/`) = instructional knowledge about _how_ to orchestrate tools:

- "To authenticate with Jellyfin, use `Authorization: Bearer {JELLYFIN_TOKEN}`"
- "To fetch watch history: GET `/Users/{userId}/Items?SortBy=DatePlayed`"
- "Requires: Jellyfin auth first"

Skills are extracted into atomic instructions, indexed by embedding, and injected contextually into the system prompt. They evolve through observation: when the agent chains multiple tool calls successfully, dependency edges are recorded. When tool errors occur, the implicated instruction is tracked for feedback loops.

## Tool Pattern

Each tool is a factory function in its own file. Returns `InternalTool`:

```typescript
// src/tools/core/memory-store.ts
const Params = Type.Object({
  content: Type.String({ description: "..." }),
});

export function createMemoryStoreTool(db: Kysely<Database>, apiKey?: string) {
  return {
    name: "memory_store",
    description: "...",
    parameters: Params,
    execute: async (_toolCallId: string, args: Static<typeof Params>) => {
      return { output: "Done", details: { id: "..." } };
    },
  };
}
```

Register in `src/tools/packs.ts` by adding to the appropriate pack (core, self, web, telegram) and importing the factory.

## Adding a New Tool

1. Create `src/tools/<pack>/my-tool.ts` with factory function
2. Define params with `Type.Object({...})` (TypeBox)
3. Import and add to pack array in `src/tools/packs.ts`
4. Tool description matters -- it's used for semantic pack selection

## Adding a Migration

1. Create `src/db/migrations/NNN-description.ts` (next number after 010)
2. Export `up(db: Kysely<unknown>)` and `down(db: Kysely<unknown>)`
3. Import in `src/db/migrate.ts` and add to the migrations array
4. Update `src/db/schema.ts` with new column types
5. Run: `just db-migrate construct`

## Testing

```bash
just test-construct       # All construct tests
just test-ai              # AI integration tests (needs OPENROUTER_API_KEY)
```

- Fixtures: `src/__tests__/fixtures.ts`
  - `setupDb()` -- in-memory DB with all migrations applied
  - `seedMemories()`, `seedGraph()`, `seedObservations()` -- populate test data
  - `memoryEmbeddings` / `queryEmbeddings` -- synthetic 16-d orthogonal vectors
  - `createTestMessage()`, `createTestObservation()`, `createTestProcessOpts()`, `createTestAgentResponse()`

## Logging

Logtape loggers by category:

| Logger         | Category                     |
| -------------- | ---------------------------- |
| `log`          | `['construct']`              |
| `agentLog`     | `['construct', 'agent']`     |
| `toolLog`      | `['construct', 'tool']`      |
| `telegramLog`  | `['construct', 'telegram']`  |
| `schedulerLog` | `['construct', 'scheduler']` |
| `dbLog`        | `['construct', 'db']`        |

- **Console sink**: always active, custom formatter
- **File sink**: active when `LOG_FILE` is set, swappable `WriteStream` for runtime rotation
- **Rotation**: on startup if log > 5 MB; manual via `self_system_status` tool with `rotate_logs: true`; keeps up to 3 archived files (`.log.1`, `.log.2`, `.log.3`)

## Environment Variables

File: `.env.construct`

**Required**: `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`

**Key optional**:

- `OPENROUTER_MODEL` -- LLM model (default: `google/gemini-3-flash-preview`)
- `DATABASE_URL` -- SQLite path (default: `./data/construct.db`)
- `ALLOWED_TELEGRAM_IDS` -- Comma-separated Telegram user IDs
- `TIMEZONE` -- Agent timezone (default: `UTC`)
- `TAVILY_API_KEY` -- Web search
- `EXTENSIONS_DIR` -- Extensions directory path
- `EMBEDDING_MODEL` -- default: `qwen/qwen3-embedding-4b`
- `MEMORY_WORKER_MODEL` -- Dedicated model for observer/reflector
- `EXT_*` -- Synced to secrets table on startup (prefix stripped)
