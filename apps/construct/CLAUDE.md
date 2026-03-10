# Construct

AI braindump companion. Telegram bot + CLI + scheduler backed by memory pipeline.

## Key Files

- `src/agent.ts` -- `processMessage()` pipeline: context assembly, tool selection, LLM call, persistence, async memory
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
    → getOrCreateConversation
    → ConstructMemoryManager.buildContext (observations + active messages)
    → recallMemories (FTS + embeddings + graph)
    → selectAndCreateTools (semantic pack selection via query embedding)
    → selectSkills (extension skills)
    → Agent.processMessage (pi-agent-core)
    → saveMessage (user + assistant)
    → trackUsage
    → async: observer → reflector → promoter → graph (cairn pipeline)
```

## Directory Structure

```
src/
├── agent.ts             # processMessage() pipeline
├── system-prompt.ts     # System prompt + identity file injection
├── memory.ts            # ConstructMemoryManager subclass
├── main.ts              # Boot sequence
├── env.ts               # Zod env validation
├── errors.ts            # ToolError, ExtensionError, AgentError, ConfigError
├── logger.ts            # Logtape logging
├── cli/index.ts         # Citty CLI (REPL, one-shot, tool invocation)
├── db/
│   ├── schema.ts        # Construct + Cairn table types (intersection)
│   ├── queries.ts       # Query helpers
│   ├── migrate.ts       # Migration runner
│   └── migrations/      # 001-010
├── tools/
│   ├── packs.ts         # Tool pack selection + InternalTool type
│   ├── core/            # Always-loaded: memory, schedule, secrets, identity, usage
│   ├── self/            # Self-modification: read, edit, test, logs, deploy, status
│   ├── web/             # Web search (Tavily) + web read
│   └── telegram/        # React, reply-to, pin/unpin, get-pinned, ask
├── telegram/
│   ├── bot.ts           # Grammy handlers, queue/threading
│   └── format.ts        # Markdown → Telegram HTML
├── scheduler/index.ts   # Croner reminder daemon
└── extensions/
    ├── loader.ts        # Dynamic tool/skill loader (jiti)
    ├── embeddings.ts    # Extension pack embeddings
    └── secrets.ts       # Secrets table + EXT_* sync
```

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
