# syntax=docker/dockerfile:1

# --- Builder ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# --- Runtime ---
FROM node:22-alpine
WORKDIR /app

RUN apk add --no-cache git

COPY --from=builder /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/ ./src/
COPY cli/ ./cli/

ENV DATABASE_URL=/data/construct.db
ENV LOG_FILE=/data/construct.log
ENV EXTENSIONS_DIR=/data/extensions

VOLUME /data

CMD ["node", "--import=tsx", "src/main.ts"]
