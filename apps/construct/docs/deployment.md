---
title: Deployment Guide
description: Docker and systemd deployment
---

# Deployment Guide

## Overview

Construct can be deployed via Docker (recommended) or as a bare-metal systemd service. Both methods support the self-deploy pipeline, where the agent commits its own code changes and triggers a restart.

## Key Files

| File                            | Role                                             |
| ------------------------------- | ------------------------------------------------ |
| `deploy/Dockerfile`             | Multi-stage Docker build                         |
| `deploy/docker-compose.yml`     | Compose configuration with volume mounts and env |
| `.dockerignore`                 | Excludes build artifacts, secrets, and dev files |
| `src/tools/self/self-deploy.ts` | Self-deploy tool (Docker-aware)                  |
| `src/main.ts`                   | Application entry point                          |

## Docker Deployment (Primary)

### Prerequisites

- Docker and Docker Compose installed on the host
- A `~/.construct/` directory for persistent data
- A `~/.construct/.env` file with required environment variables

### 1. Configure Environment

Create the data directory and environment file:

```bash
mkdir -p ~/.construct/extensions/skills ~/.construct/extensions/tools
```

Create `~/.construct/.env` with at minimum:

```bash
OPENROUTER_API_KEY=sk-or-v1-...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

See the Environment Variables section in `CLAUDE.md` for all available variables. Note that `DATABASE_URL`, `LOG_FILE`, and `EXTENSIONS_DIR` are pre-set in the Dockerfile to point to `/data/` paths, so you do not need to set them in your `.env` file.

### 2. Build and Run

From the project root:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

This will:

1. Build a multi-stage image using `node:22-alpine`
2. Install dependencies in a builder stage, then copy only `node_modules` to the runtime stage
3. Install `git` in the runtime stage (required for self-deploy commits)
4. Mount `~/.construct` on the host to `/data` in the container
5. Load environment variables from `~/.construct/.env`
6. Start the application with `restart: unless-stopped`

### 3. Verify

```bash
docker compose -f deploy/docker-compose.yml logs -f
```

Look for `Construct is running` in the output.

### Volume Layout

The host directory `~/.construct/` maps to `/data` inside the container:

```
~/.construct/           (host)  -->  /data/           (container)
  .env                               (env_file, not mounted inside /data)
  construct.db                       construct.db     (SQLite database)
  construct.log                      construct.log    (log file)
  extensions/                        extensions/      (EXTENSIONS_DIR)
    SOUL.md                            SOUL.md
    IDENTITY.md                        IDENTITY.md
    USER.md                            USER.md
    skills/                            skills/
    tools/                             tools/
```

The `.env` file is read by Docker Compose via `env_file:` -- it is injected as environment variables into the container, not mounted as a file inside `/data`.

### Dockerfile Details

The Dockerfile (`deploy/Dockerfile`) uses a two-stage build:

**Builder stage** -- installs dependencies:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
```

**Runtime stage** -- copies dependencies and source:

```dockerfile
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache git
COPY --from=builder /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/ ./src/
COPY cli/ ./cli/
```

Environment defaults baked into the image:

- `DATABASE_URL=/data/construct.db`
- `LOG_FILE=/data/construct.log`
- `EXTENSIONS_DIR=/data/extensions`

Entry point: `node --import=tsx src/main.ts`

### Docker Compose Configuration

The compose file (`deploy/docker-compose.yml`) is minimal:

```yaml
services:
  construct:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    volumes:
      - ~/.construct:/data
    env_file:
      - ~/.construct/.env
    restart: unless-stopped
```

Key points:

- Build context is `..` (project root), since the compose file lives in `deploy/`
- `restart: unless-stopped` is critical for the self-deploy mechanism (see below)

## Self-Deploy in Docker

The `self_deploy` tool in `src/tools/self/self-deploy.ts` detects Docker by checking for `/.dockerenv`. The deploy pipeline differs between Docker and systemd:

### Common Steps (Both Environments)

1. **Typecheck** -- `tsc --noEmit` must pass
2. **Tests** -- `vitest run` must pass
3. **Backup tag** -- Creates a git tag `pre-deploy-TIMESTAMP` at the current HEAD
4. **Commit** -- Stages `src/`, `cli/`, and `extensions/`, then commits

### Docker-Specific Restart

After committing, the tool calls `process.exit(0)` via `setImmediate`. The Docker `restart: unless-stopped` policy then restarts the container. Since the source code lives inside the container's `/app` directory (not on a volume), the restarted container uses the **same committed code** because git tracks the working tree in-place.

```
Agent edits code --> self_deploy commits --> process.exit(0) --> Docker restarts container
                                                                 --> tsx loads updated source
```

There is no health check or auto-rollback in Docker mode. The container simply restarts. If the new code crashes on startup, Docker's restart policy will keep retrying.

### Systemd-Specific Restart

In non-Docker environments, the tool runs `sudo systemctl restart <service>`, waits 5 seconds, checks `systemctl is-active`, and auto-rolls back with `git revert HEAD` if the service failed to start.

## Updating the Deployment

To update Construct after pulling new changes:

```bash
cd /path/to/construct
git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

The `--build` flag rebuilds the image with the latest source and dependencies. The container restarts automatically.

To update without rebuilding (if only extension files changed, which live on the volume):

```bash
docker compose -f deploy/docker-compose.yml restart
```

## Non-Docker Deployment (systemd)

For bare-metal deployment without Docker:

### 1. Install Dependencies

```bash
git clone <repo> /opt/construct
cd /opt/construct
pnpm install --frozen-lockfile
```

### 2. Create Environment File

```bash
cp .env.example .env
# Edit .env with your API keys and configuration
```

### 3. Create systemd Service

```ini
[Unit]
Description=Construct Telegram Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/construct
ExecStart=/usr/bin/node --env-file=.env --import=tsx src/main.ts
Restart=on-failure
User=construct

[Install]
WantedBy=multi-user.target
```

### 4. Enable and Start

```bash
sudo systemctl enable construct
sudo systemctl start construct
```

The self-deploy tool expects the systemd unit to be named `construct` by default (configurable via the `serviceUnit` parameter in `createSelfDeployTool()`). The agent process needs passwordless `sudo` for `systemctl restart construct` and `systemctl is-active construct`.

## Rate Limiting

Self-deploy is rate-limited to 3 deploys per hour in both Docker and systemd modes. The rate limit is tracked in-memory (`deployHistory` array in `self-deploy.ts`), so it resets on process restart.
