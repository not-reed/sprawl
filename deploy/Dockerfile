# syntax=docker/dockerfile:1

# --- Builder ---
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/cairn/package.json ./packages/cairn/
COPY packages/env/package.json ./packages/env/
COPY packages/log/package.json ./packages/log/
COPY apps/construct/package.json ./apps/construct/
RUN pnpm install --frozen-lockfile

# --- Runtime ---
FROM node:22-alpine
WORKDIR /app

RUN apk add --no-cache git && corepack enable pnpm

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=builder /app/packages/cairn/node_modules ./packages/cairn/node_modules
COPY --from=builder /app/packages/env/node_modules ./packages/env/node_modules
COPY --from=builder /app/packages/log/node_modules ./packages/log/node_modules
COPY --from=builder /app/apps/construct/node_modules ./apps/construct/node_modules

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/ ./packages/
COPY apps/construct/ ./apps/construct/

ENV DATABASE_URL=/data/construct.db
ENV LOG_FILE=/data/construct.log
ENV EXTENSIONS_DIR=/data/extensions

VOLUME /data

WORKDIR /app/apps/construct
CMD ["node", "--import=tsx", "src/main.ts"]
