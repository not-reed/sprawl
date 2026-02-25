# Development Workflow

*Last updated: 2026-02-25 -- Updated self-deploy section for Docker-aware behavior*

## Overview

Construct uses tsx for TypeScript execution, Vitest for testing, and a file-watching dev mode. The project runs directly from TypeScript source -- there is no build/compile step for development or production.

## Key Files

| File | Role |
|------|------|
| `package.json` | Scripts, dependencies |
| `tsconfig.json` | TypeScript configuration |
| `vitest.config.ts` | Test configuration |
| `src/logger.ts` | Logging with rotation |

## npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm run dev` | `NODE_ENV=development node --env-file=.env --import=tsx --watch-path=src --watch-path=cli src/main.ts` | Dev mode with file watching on `src/` and `cli/` |
| `npm run start` | `node --env-file=.env --import=tsx src/main.ts` | Production start (Telegram + scheduler) |
| `npm run cli` | `node --env-file=.env --import=tsx cli/index.ts` | CLI interface (REPL/one-shot/tool mode) |
| `npm run telegram` | `node --env-file=.env --import=tsx src/telegram/index.ts` | Telegram bot only (no scheduler) |
| `npm run db:migrate` | `node --env-file=.env --import=tsx src/db/migrate.ts` | Run database migrations |
| `npm run test` | `vitest run` | Run tests once |
| `npm run test:watch` | `vitest` | Run tests in watch mode |
| `npm run typecheck` | `tsc --noEmit` | Type checking without emit |

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
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
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
npm run test              # Run all tests once
npm run test:watch        # Watch mode
npx vitest run -t memory  # Filter by test name
```

The self_run_tests tool also runs `npx vitest run --reporter=verbose` with a 60-second timeout.

## Logging

### Logtape Setup

The logging system uses `@logtape/logtape` with these loggers:

| Logger | Category |
|--------|----------|
| `log` | `['construct']` |
| `agentLog` | `['construct', 'agent']` |
| `toolLog` | `['construct', 'tool']` |
| `telegramLog` | `['construct', 'telegram']` |
| `schedulerLog` | `['construct', 'scheduler']` |
| `dbLog` | `['construct', 'db']` |

### Sinks

- **Console**: Always active, uses a custom formatter
- **File**: Active when `LOG_FILE` is set. Uses a swappable `WriteStream` to support runtime log rotation.

### Log Format

```
2026-02-24T15:30:00.000Z [info] construct.agent: Processing message from telegram
```

### Log Rotation

- Automatic: On startup, if the log file exceeds 5 MB, it is rotated
- Manual: The `self_system_status` tool can trigger rotation via `rotate_logs: true`
- Rotation keeps up to 3 archived files: `construct.log.1`, `construct.log.2`, `construct.log.3`

## Deployment (Self-Deploy)

The `self_deploy` tool handles automated deployment. It detects the runtime environment by checking for `/.dockerenv`:

**Common steps (both environments):**

1. Typecheck (`tsc --noEmit`)
2. Test (`vitest run`)
3. Git tag backup (`pre-deploy-TIMESTAMP`)
4. Git commit (`src/`, `cli/`, and `extensions/` directories)

**Docker mode** (detected via `/.dockerenv`):

5. `process.exit(0)` -- container restarts via `restart: unless-stopped` policy

**Systemd mode** (non-Docker):

5. `sudo systemctl restart construct`
6. Health check (5-second wait, then `systemctl is-active`)
7. Auto-rollback on failure (`git revert HEAD`, restart)

Self-deploy is:
- **Disabled** in development mode (`NODE_ENV=development`)
- **Rate-limited** to 3 deploys per hour
- **Safety-gated** by a `confirm: true` parameter

See [Deployment Guide](./deployment.md) for full details on Docker and systemd deployment, and [Security Considerations](./security.md) for the complete safety model.

## Dev Mode Differences

When `NODE_ENV=development`:
- File watching is active (`--watch-path`)
- `self_deploy` tool is not loaded (returns null from factory)
- Context preamble includes `[DEV MODE]` and a development warning
- `EXTENSIONS_DIR` defaults to `./data` instead of XDG path

## Dependencies

### Runtime

| Package | Version | Purpose |
|---------|---------|---------|
| `@mariozechner/pi-agent-core` | ^0.54.2 | Agent framework |
| `@mariozechner/pi-ai` | ^0.54.2 | LLM model access |
| `@sinclair/typebox` | ^0.34.48 | JSON Schema / TypeBox for tool parameters |
| `grammy` | ^1.40.0 | Telegram Bot API |
| `kysely` | ^0.28.11 | Type-safe SQL query builder |
| `croner` | ^10.0.1 | Cron job scheduling |
| `citty` | ^0.2.1 | CLI framework |
| `jiti` | ^2.6.1 | Dynamic TypeScript loading (extensions) |
| `@logtape/logtape` | ^2.0.2 | Structured logging |
| `nanoid` | ^5.1.6 | ID generation |
| `yaml` | ^2.8.2 | YAML parsing (skill frontmatter) |
| `zod` | ^4.3.6 | Environment validation |
| `date-fns` | ^4.1.0 | Date utilities |
| `chalk` | ^5.6.2 | Terminal coloring |
| `consola` | ^3.4.2 | Console utilities |

### Dev

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.9.3 | Type checking |
| `tsx` | ^4.21.0 | TypeScript execution |
| `vitest` | ^4.0.18 | Testing framework |
| `@types/node` | ^25.3.0 | Node.js type definitions |

## Related Documentation

- [Architecture Overview](./../architecture/overview.md) -- System startup sequence
- [Environment Configuration](./environment.md) -- Environment variables
- [Deployment Guide](./deployment.md) -- Docker and systemd deployment
- [Security Considerations](./security.md) -- Self-deploy safety gates
- [Tool System](./../features/tools.md) -- Self-modification tools
