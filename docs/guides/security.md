---
title: Security Considerations
description: "Self-modification safety, secrets, and trust boundaries"
---

# Security Considerations

## Overview

Construct is an AI agent that can read, edit, test, and deploy its own source code. This self-modification capability is powerful but requires careful safety boundaries. This document covers the security model, trust boundaries, and operational considerations.

## Self-Modification Safety

The agent has three self-modification tools: `self_read_source`, `self_edit_source`, and `self_deploy`. Each has explicit safety gates.

### File Access Scoping

Both `self_read_source` (`src/tools/self/self-read.ts`) and `self_edit_source` (`src/tools/self/self-edit.ts`) enforce path restrictions:

**Read access** is limited to:
- `src/` -- application source
- `cli/` -- CLI source
- `extensions/` -- user/agent-authored extensions (resolved against `EXTENSIONS_DIR`)
- `package.json`, `tsconfig.json`, `CLAUDE.md`, `PLAN.md` -- read-only config files

**Write access** is limited to:
- `src/` -- application source
- `cli/` -- CLI source
- `extensions/` -- extensions directory

Both tools resolve paths against the project root and perform explicit prefix checks. Path traversal attacks (e.g., `../../etc/passwd`) are blocked -- the tool checks that the resolved path does not start with `..` relative to the allowed root.

The extension path prefix (`extensions/`) is resolved against `EXTENSIONS_DIR`, not the project root, with its own traversal guard:

```typescript
if (!resolved.startsWith(resolve(extensionsDir) + '/') && resolved !== resolve(extensionsDir)) {
  return { output: 'Access denied: escapes the extensions directory.' }
}
```

### Self-Deploy Safety Gates

The `self_deploy` tool (`src/tools/self/self-deploy.ts`) has multiple safety layers:

1. **Explicit confirmation** -- The `confirm` parameter must be `true`. The tool description instructs the agent to only set this after verifying the change is correct.

2. **Typecheck gate** -- `tsc --noEmit` must pass before any commit. If types fail, deploy is aborted with the error output.

3. **Test gate** -- `vitest run` must pass. If tests fail, deploy is aborted with test output.

4. **Backup tags** -- Before committing, a git tag `pre-deploy-YYYY-MM-DDTHH-MM-SS-SSSZ` is created at the current HEAD. This enables manual recovery even if auto-rollback fails.

5. **Rate limiting** -- Maximum 3 deploys per hour. Tracked in-memory via a `deployHistory` array that prunes entries older than one hour.

6. **Auto-rollback (systemd only)** -- After restarting the service, the tool waits 5 seconds and checks `systemctl is-active`. If the service is not healthy, it runs `git revert --no-edit HEAD` and restarts again. If rollback itself fails, the tool reports the backup tag for manual recovery.

7. **Scoped staging** -- Only `src/`, `cli/`, and `extensions/` are staged for commit (`git add src/ cli/ extensions/`). System files, configuration, and the data directory are never committed by the agent.

### Docker Caveat

In Docker mode, the auto-rollback mechanism is **not available**. The tool calls `process.exit(0)` and relies on Docker's `restart: unless-stopped` policy. If the new code crashes on startup, Docker will keep restarting the container. Manual intervention is needed to recover -- use the backup git tag to revert.

## Secrets Management

### Architecture

Secrets are stored in the `secrets` table in SQLite with columns: `key`, `value`, `source`, `updated_at`. The `source` field tracks whether a secret came from the environment (`'env'`) or was stored by the agent (`'agent'`).

### EXT_* Environment Variable Sync

On startup, `syncEnvSecrets()` in `src/extensions/secrets.ts` scans `process.env` for variables prefixed with `EXT_`, strips the prefix, and upserts them into the `secrets` table with `source='env'`:

```
EXT_OPENWEATHERMAP_API_KEY=abc123  -->  secrets.key = "OPENWEATHERMAP_API_KEY"
```

Environment-sourced secrets **always overwrite** existing values on restart. This means the `.env` file is the authoritative source for any `EXT_*` secret.

### Secret Exposure Controls

- The `secret_list` tool returns only key names and sources -- **never values**.
- The `secret_store` tool allows the agent to create secrets with `source='agent'`.
- Secrets are passed to dynamic extension tools via `DynamicToolContext.secrets`, a `Map<string, string>` built by `buildSecretsMap()`.
- Secrets are **never logged** -- the logging calls in `secrets.ts` only log the count of synced secrets, not their values.

### .env File Security

The `.env` file contains the most sensitive credentials (`OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`, and any `EXT_*` secrets). It must never be committed to version control:

- `.gitignore` should include `.env`
- `.dockerignore` explicitly excludes `.env` to prevent it from being baked into Docker images
- In Docker, the `.env` file lives at `~/.construct/.env` on the host and is loaded via `env_file:` in docker-compose.yml

## Docker Security

### Container Configuration

The Dockerfile (`deploy/Dockerfile`) and compose file (`deploy/docker-compose.yml`) have these security-relevant properties:

**Runtime dependencies** -- The container installs `git` (for self-deploy commits) but no other system tools. Notably, `sudo` is **not** installed -- there is no systemd inside the container, so privilege escalation for service restart is unnecessary.

**Base image** -- `node:22-alpine` is a minimal image. Alpine's small surface area reduces exposure.

**Volume mount** -- `~/.construct:/data` gives the container read/write access to:
- The SQLite database (`construct.db`)
- The log file (`construct.log`)
- The extensions directory (`extensions/`)

The container does **not** have access to the host's project source, `.git` directory, or any other host paths.

**No privileged mode** -- The compose file does not use `privileged: true` or add any Linux capabilities.

### Running as Non-Root

By default, the `node:22-alpine` image runs as `root` inside the container. For hardened deployments, add a non-root user to the Dockerfile:

```dockerfile
RUN addgroup -S construct && adduser -S construct -G construct
USER construct
```

If you do this, ensure the `/data` volume directory is writable by the `construct` user. On the host:

```bash
# Find the UID of the construct user in the container (typically 100)
docker compose -f deploy/docker-compose.yml run --rm construct id
# Then chown the host directory
sudo chown -R <uid>:<gid> ~/.construct
```

### .dockerignore

The `.dockerignore` file prevents sensitive and unnecessary files from entering the build context:

```
node_modules    # Rebuilt in builder stage
.git            # Not needed at build time (git is used at runtime for self-deploy)
data/           # Local dev data directory
.env            # Secrets -- must not be baked into image
.claude/        # Editor/agent state
.docs/          # Documentation
```

### Network Exposure

The container does not expose any ports. Construct communicates with Telegram via outbound long polling (HTTPS), and with OpenRouter via outbound HTTPS. No inbound connections are needed.

## Extension System Trust

### Dynamic Tool Loading

Extension tools are TypeScript files loaded at runtime via `jiti` (a TypeScript-to-JavaScript transpiler). The loading happens in `src/extensions/loader.ts` via `loadSingleToolFile()`:

```typescript
const { createJiti } = await import('jiti')
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false })
const mod = await jiti.import(filePath)
```

**Trust implication**: Any `.ts` file placed in `$EXTENSIONS_DIR/tools/` will be imported and executed with the full privileges of the Node.js process. There is no sandboxing. A malicious extension tool could:

- Read/write any file accessible to the process
- Make network requests
- Access environment variables (including API keys)
- Execute child processes

**Mitigations**:
- Extensions are loaded only from `EXTENSIONS_DIR`, which is a controlled directory
- The agent can only create files within the `extensions/` scope via `self_edit_source`
- `moduleCache: false` ensures tools are freshly loaded on each `reloadExtensions()` call, so stale or modified tools are not cached
- Requirement checking (`checkRequirements()` in `loader.ts`) validates that needed secrets and env vars exist before loading, but this is a functionality check, not a security gate

### Node Modules Symlink

The loader creates a symlink from `$EXTENSIONS_DIR/node_modules` to the project's `node_modules` so that extension tools can import project dependencies like `@sinclair/typebox`. This is done via `ensureNodeModulesLink()`. The symlink is created only if it does not already exist.

### Skills (Markdown)

Skills are Markdown files with YAML frontmatter. They are parsed and injected into the system prompt as text. Since they are not executed as code, the trust boundary is lower -- a malicious skill could only influence the agent's behavior through prompt injection, not execute arbitrary code.

## Telegram Bot Token Security

The Telegram bot token (`TELEGRAM_BOT_TOKEN`) provides full control of the bot account. If compromised, an attacker could:

- Read all messages sent to the bot
- Send messages as the bot
- Access any data the bot has been given

### Authorization

The `ALLOWED_TELEGRAM_IDS` environment variable restricts which Telegram users can interact with the bot. In `src/telegram/bot.ts`:

```typescript
function isAuthorized(userId: string): boolean {
  return allowedIds.length === 0 || allowedIds.includes(userId)
}
```

If `ALLOWED_TELEGRAM_IDS` is empty (the default), **all users are allowed**. For production, always set this to a comma-separated list of trusted Telegram user IDs.

Authorization is checked for:
- Text messages (`bot.on('message:text')`)
- Reactions (`bot.on('message_reaction')`)
- Other message types (`bot.on('message')`)

Unauthorized users receive a single "Unauthorized." response for text messages. Unauthorized reactions and other message types are silently ignored.

### Recommendations

1. **Always set `ALLOWED_TELEGRAM_IDS`** in production to restrict access to trusted users
2. **Rotate the bot token** if you suspect it has been exposed (use @BotFather on Telegram)
3. **Do not log message content** at `debug` level in production -- the current logging truncates messages to 100 characters at `info` level

## Summary of Trust Boundaries

```
+---------------------------+----------------------------------+
| Boundary                  | Protection                       |
+---------------------------+----------------------------------+
| File system access        | Path scoping to src/, cli/,      |
|                           | extensions/ with traversal guard  |
+---------------------------+----------------------------------+
| Code deployment           | Typecheck, tests, confirm flag,  |
|                           | rate limit, backup tag, rollback  |
+---------------------------+----------------------------------+
| Secrets in memory         | Values never logged, list tool   |
|                           | returns only key names            |
+---------------------------+----------------------------------+
| .env file                 | Excluded from Docker image and   |
|                           | git via ignore files              |
+---------------------------+----------------------------------+
| Extension tools           | No sandbox -- full process       |
|                           | privileges; mitigated by         |
|                           | controlled EXTENSIONS_DIR        |
+---------------------------+----------------------------------+
| Telegram access           | ALLOWED_TELEGRAM_IDS whitelist   |
|                           | (empty = open to all)            |
+---------------------------+----------------------------------+
| Docker container          | No exposed ports, no sudo,       |
|                           | minimal Alpine base, volume-only |
|                           | data access                      |
+---------------------------+----------------------------------+
```
