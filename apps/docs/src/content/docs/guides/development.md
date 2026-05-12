---
title: Development Workflow
description: "Just commands, testing, logging, and TypeScript config"
---

# Development Workflow

## Overview

Sprawl uses tsx for TypeScript execution, Vitest for testing, and Just for task orchestration. All TS apps run directly from source -- no build step. Optic is the exception (Rust, compiled with cargo).

## Key Files

| File                      | Role                            |
| ------------------------- | ------------------------------- |
| `Justfile`                | Task runner (primary interface) |
| `pnpm-workspace.yaml`     | Workspace config                |
| `apps/*/package.json`     | App dependencies                |
| `packages/*/package.json` | Package dependencies            |

## Just Commands

| Command                       | Description                                              |
| ----------------------------- | -------------------------------------------------------- |
| `just dev`                    | Construct dev mode (file watching)                       |
| `just start <instance>`       | Start named Construct instance (reads `.env.<instance>`) |
| `just cli [instance] [args]`  | Construct CLI                                            |
| `just cortex-dev`             | Cortex dev mode                                          |
| `just cortex-start`           | Cortex production                                        |
| `just cortex-backfill [days]` | Backfill historical data                                 |
| `just synapse-dev`            | Synapse dev mode                                         |
| `just synapse-start`          | Synapse production                                       |
| `just synapse-status`         | Portfolio summary                                        |
| `just deck-dev <instance>`    | Deck dev mode                                            |
| `just optic [db] [synapse]`   | Optic TUI                                                |
| `just optic-build`            | Build Optic release binary                               |
| `just test`                   | Run all tests (`pnpm -r run test`)                       |
| `just test-construct`         | Construct tests only                                     |
| `just test-cairn`             | Cairn tests only                                         |
| `just test-synapse`           | Synapse tests only                                       |
| `just test-ai`                | AI integration tests                                     |
| `just typecheck`              | Typecheck all packages                                   |
| `just db-migrate [inst]`      | Run Construct DB migrations                              |

Each app reads its env from `.env.construct`, `.env.cortex`, `.env.synapse`, `.env.loom`, etc. Named instances (e.g., `just start myinstance`) read from `.env.myinstance`.

## TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

Key points:

- **No compilation**: `noEmit: true` -- tsx handles runtime transpilation
- **Path alias**: `@/*` maps to `./src/*` (used in vitest config)
- **Strict mode**: Full TypeScript strict checks enabled
- **Bundler module resolution**: Modern resolution compatible with tsx

## Runtime Execution

The project uses `tsx` (via `--import=tsx`) as a TypeScript loader. This means:

- No build step required
- Source files are transpiled on-the-fly
- File watching uses Node.js native `--watch-path` flag
- Extension tool files use `jiti` instead of `tsx` for dynamic loading

## Testing

### Vitest Configuration

```typescript
export default defineConfig({
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
```

- **Global test functions**: `describe`, `it`, `expect`, etc. are available without imports
- **Node environment**: Tests run in Node.js (not jsdom)
- **Path alias**: `@/` resolves to `src/` in test files

### Test Organization

Tests are colocated with their source in `__tests__/` directories:

```
src/tools/core/__tests__/
  memory.test.ts
  schedule.test.ts
src/tools/self/__tests__/
  deploy.test.ts
  exec.test.ts
  extension-scope.test.ts
  self.test.ts
src/tools/web/__tests__/
  web.test.ts
src/tools/__tests__/
  packs.test.ts
src/extensions/__tests__/
  dynamic-tools.test.ts
  loader.test.ts
  secrets.test.ts
  skills.test.ts
```

### Running Tests

```bash
just test                 # Run all tests (pnpm -r run test)
just test-construct       # Construct tests only
just test-cairn           # Cairn tests only
npx vitest run -t memory  # Filter by test name
```

The self_run_tests tool also runs `npx vitest run --reporter=verbose` with a 60-second timeout.

## Logging

### Logtape Setup

The logging system uses `@logtape/logtape` with these loggers:

| Logger         | Category                     |
| -------------- | ---------------------------- |
| `log`          | `['construct']`              |
| `agentLog`     | `['construct', 'agent']`     |
| `toolLog`      | `['construct', 'tool']`      |
| `telegramLog`  | `['construct', 'telegram']`  |
| `schedulerLog` | `['construct', 'scheduler']` |
| `dbLog`        | `['construct', 'db']`        |

### Sinks

- **Console**: Always active, uses a custom formatter
- **File**: Active when `LOG_FILE` is set. Uses a swappable `WriteStream` to support runtime log rotation.

### Log Format

```
2026-02-24T15:30:00.000Z [info] construct.agent: Processing message from telegram
```

### Log Rotation

- Automatic: On startup, if the log file exceeds 5 MB, it is rotated
- Manual: The `shell` tool can trigger rotation (e.g., `truncate -c -s 0 logfile`)
- Rotation keeps up to 3 archived files: `construct.log.1`, `construct.log.2`, `construct.log.3`

## Deployment

Deployment is manual. After the agent edits code via `edit` and `shell` tools:

**Docker:**

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

**Systemd:**

```bash
sudo systemctl restart construct
```

Recommended: run `just check` before deploying. Create a git tag for rollback:

```bash
git tag pre-deploy-$(date -u +%Y%m%d-%H%M%S)
```

See [Deployment Guide](/guides/deployment/) for full details.

## Dev Mode Differences

When `NODE_ENV=development`:

- File watching is active (`--watch-path`)
- Deployment is manual (no self-deploy tool)
- Context preamble includes `[DEV MODE]` and a development warning
- `EXTENSIONS_DIR` defaults to `./data` instead of XDG path

## Dependencies

### Runtime

| Package                       | Version  | Purpose                                   |
| ----------------------------- | -------- | ----------------------------------------- |
| `@mariozechner/pi-agent-core` | ^0.54.2  | Agent framework                           |
| `@mariozechner/pi-ai`         | ^0.54.2  | LLM model access                          |
| `@sinclair/typebox`           | ^0.34.48 | JSON Schema / TypeBox for tool parameters |
| `grammy`                      | ^1.40.0  | Telegram Bot API                          |
| `kysely`                      | ^0.28.11 | Type-safe SQL query builder               |
| `croner`                      | ^10.0.1  | Cron job scheduling                       |
| `citty`                       | ^0.2.1   | CLI framework                             |
| `jiti`                        | ^2.6.1   | Dynamic TypeScript loading (extensions)   |
| `@logtape/logtape`            | ^2.0.2   | Structured logging                        |
| `nanoid`                      | ^5.1.6   | ID generation                             |
| `yaml`                        | ^2.8.2   | YAML parsing (skill frontmatter)          |
| `zod`                         | ^4.3.6   | Environment validation                    |
| `date-fns`                    | ^4.1.0   | Date utilities                            |
| `chalk`                       | ^5.6.2   | Terminal coloring                         |
| `consola`                     | ^3.4.2   | Console utilities                         |

### Dev

| Package       | Version | Purpose                  |
| ------------- | ------- | ------------------------ |
| `typescript`  | ^5.9.3  | Type checking            |
| `tsx`         | ^4.21.0 | TypeScript execution     |
| `vitest`      | ^4.0.18 | Testing framework        |
| `@types/node` | ^25.3.0 | Node.js type definitions |
