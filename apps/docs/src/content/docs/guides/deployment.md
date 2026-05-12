---
title: Deployment Guide
description: Docker and systemd deployment
---

# Deployment Guide

## Overview

Construct can be deployed via Docker (recommended) or as a bare-metal systemd service. Code changes made by the agent via the `edit` and `shell` tools must be deployed manually.

## Key Files

| File                        | Role                                             |
| --------------------------- | ------------------------------------------------ |
| `deploy/Dockerfile`         | Multi-stage Docker build                         |
| `deploy/docker-compose.yml` | Compose configuration with volume mounts and env |
| `.dockerignore`             | Excludes build artifacts, secrets, and dev files |
| `src/main.ts`               | Application entry point                          |

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

See [Environment Configuration](/guides/environment/) for all available variables. Note that `DATABASE_URL`, `LOG_FILE`, and `EXTENSIONS_DIR` are pre-set in the Dockerfile to point to `/data/` paths, so you do not need to set them in your `.env` file.

### 2. Build and Run

From the project root:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

This will:

1. Build a multi-stage image using `node:22-alpine`
2. Install dependencies in a builder stage, then copy only `node_modules` to the runtime stage
3. Install `git` in the runtime stage (optional, for version control)
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
- `restart: unless-stopped` ensures the container restarts if the process exits

## Updating the Agent

After the agent edits its own source code via the `edit` and `shell` tools, changes must be deployed manually. There is no automatic self-deploy mechanism.

### Docker Update

After code changes are committed inside the container:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

The `--build` flag rebuilds the image with the latest source. The container restarts with the new code.

### Systemd Update

On bare-metal deployments:

```bash
cd /opt/construct
git pull
pnpm install --frozen-lockfile
sudo systemctl restart construct
```

Wait 5 seconds and verify: `sudo systemctl is-active construct`

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

The systemd unit is named `construct` by default. The agent process needs passwordless `sudo` for `systemctl restart construct` and `systemctl is-active construct` if you want the agent to restart itself via the `shell` tool.
