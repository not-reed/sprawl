---
title: Loom
description: Interactive rulebook companion with TTS
---

# Loom

## Overview

Interactive rulebook companion for tabletop RPGs. A Hono REST API + React SPA for chatting with ingested rulebooks. Features multi-voice TTS audio generation via Kokoro, campaign management, session-based conversations, and full Cairn memory integration (observations, memories, knowledge graph).

## How it works

### Boot sequence (`src/main.ts`)

1. Run DB migrations (Cairn tables + campaigns/sessions)
2. Create Kysely DB via `@repo/db`
3. Start Hono server on configured port (default: 4900)
4. Register graceful shutdown on SIGINT/SIGTERM

### Agent (`src/agent.ts`)

`processMessage()` handles each chat turn:

1. Look up session + campaign context
2. Create `MemoryManager` from `@repo/cairn`
3. Hybrid memory recall: rules (by category) + campaign memories (by embedding similarity)
4. Build context preamble with timezone, mode (play/recap), campaign info, observations, rules, memories
5. Replay conversation history into pi-agent-core Agent
6. Run agent with GM system prompt (dice protocol, TTS-friendly format rules)
7. Async post-response: observe -> promote -> reflect (same Cairn pipeline as Construct)

The system prompt enforces TTS-friendly output: no markdown, no code blocks, no em dashes, hyphens spelled out.

### Rulebook Ingestion (`src/ingest.ts`)

CLI script to chunk and ingest rulebooks into the memory pipeline:

1. Scans `RULES_DIR` for `.md` and `.txt` files
2. Splits on heading hierarchy, respects ~1500 token limits
3. Stores each chunk as a `category: 'rules'` memory with embedding
4. Runs async graph extraction (NPCs, locations, items, spells, etc.)
5. Progress logging per file

Run via `just loom-ingest`.

### Text-to-Speech

Three-layer TTS pipeline:

**Kokoro client** (`src/tts/kokoro.ts`):

- OpenAI-compatible API client for Kokoro FastAPI server
- Handles streaming and buffered synthesis
- Text cleaning: strips code, tables, dice notation, stat blocks, markdown

**Scriptify** (`src/tts/scriptify.ts`):

- LLM-powered script adaptation for multi-voice narration
- Parses `[SPEAKER]` tagged output, maps characters to configured voices
- Falls back to single-voice on parse failure
- Tracks usage

**Voices** (`src/tts/voices.ts`):

- Static voice catalog with quality grades
- Blend expression builder (e.g., `af_heart(0.7)+af_sky(0.3)`)
- Live voice detection from Kokoro server

**Audio assembly** (`src/routes/audio.ts`):

- Multi-voice parallel synthesis per segment
- In-memory audio cache with TTL cleanup
- Falls back gracefully if TTS disabled

### Docker (`docker-compose.yml`)

Single service: Kokoro FastAPI TTS (CPU-optimized v0.2.4). Port 8880. Model volume persistence.

## API Routes

### `POST /api/chat`

SSE streaming endpoint. Events:

- `delta` -- Incremental text chunks
- `done` -- Final message with full text
- `audio` -- TTS audio stream URL (if enabled)
- `error` -- Error message

### `GET /api/chat/tts-stream/:id`

Serves cached audio for a completed TTS generation.

### Campaigns (`/api/campaigns`)

- `GET /` -- List all campaigns
- `POST /` -- Create campaign (name, description, system)
- `GET /:id` -- Campaign detail
- `PATCH /:id` -- Update campaign
- `POST /:id/sessions` -- Create new session for campaign

### Sessions (`/api/sessions`)

- `GET /:id` -- Session detail with messages
- `PATCH /:id` -- Update session metadata
- `GET /:id/observations` -- Session observations from Cairn

### Settings (`/api/settings`)

- `GET /voices` -- Voice catalog from Kokoro
- `GET /voice-config` -- Per-campaign voice assignments
- `PUT /voice-config` -- Store voice config
- `POST /voice-preview` -- Generate voice sample
- `GET /characters/:sessionId` -- Extract character names from graph + recent messages

### Debug (`/api/debug`)

- `POST /scriptify` -- Test scriptify pipeline
- `POST /synthesize-segment` -- Test single segment synthesis

## Database

Six migrations (Cairn base + Loom additions):

| Migration                     | Description                                              |
| ----------------------------- | -------------------------------------------------------- |
| `001-initial`                 | Cairn base tables                                        |
| `002-fts5-and-embeddings`     | FTS5, triggers, embeddings                               |
| `003-graph-memory`            | Graph nodes + edges                                      |
| `004-observational-memory`    | Observations table, watermarks                           |
| `005-observation-promoted-at` | Promoter tracking                                        |
| `006-campaigns`               | `campaigns` + `sessions` tables with FK to conversations |

## Key Files

| File                      | Role                                                      |
| ------------------------- | --------------------------------------------------------- |
| `src/main.ts`             | Entry point, migrations, server start                     |
| `src/server.ts`           | Hono app setup, CORS, route mounting, static serving      |
| `src/agent.ts`            | Chat agent with rulebook context + Cairn memory           |
| `src/system-prompt.ts`    | GM system prompt, dice protocol, TTS format rules         |
| `src/ingest.ts`           | Rulebook ingestion: chunking, embedding, graph extraction |
| `src/env.ts`              | Zod-validated env config                                  |
| `src/tts/kokoro.ts`       | Kokoro TTS client (OpenAI-compatible API)                 |
| `src/tts/scriptify.ts`    | LLM script adaptation for multi-voice narration           |
| `src/tts/voices.ts`       | Voice catalog and blend expressions                       |
| `src/routes/chat.ts`      | SSE chat streaming + TTS audio serving                    |
| `src/routes/campaigns.ts` | Campaign CRUD                                             |
| `src/routes/sessions.ts`  | Session detail + observations                             |
| `src/routes/audio.ts`     | Audio caching, voice config, multi-voice synthesis        |
| `src/routes/settings.ts`  | Voice catalog, config, character extraction               |
| `src/routes/debug.ts`     | TTS debugging endpoints                                   |
| `src/db/schema.ts`        | Campaign + session table types                            |
| `src/db/queries.ts`       | DB operations                                             |

## Frontend (`web/`)

React 19 SPA with React Router. Built with Vite.

- **CampaignList** -- Browse/create campaigns
- **CampaignView** -- Campaign detail with sessions
- **PlayView** -- Chat panel + session sidebar (main play interface)
- **ChatPanel** -- Message list with SSE streaming + auto-play audio
- **VoiceSettings** -- Per-campaign voice assignments with preview
- **TtsDebug** -- Developer TTS testing

Hooks: `useChat` (SSE streaming + message state), `useSession` (metadata), `useApi` (generic fetch).

## Integration Points

- **@repo/cairn** -- Full memory pipeline: observe/reflect/promote/graph after each turn. Rules stored as memories. Graph extraction for NPCs/locations.
- **@repo/db** -- `createDb()` for database connection, migration runner.
- **Kokoro** -- Self-hosted TTS via Docker. CPU-optimized, multi-voice.
- **OpenRouter** -- LLM inference for agent + scriptify + memory workers.

## Running

```bash
just loom-dev     # Backend dev mode (file watching)
just loom-web     # Frontend Vite dev server (proxies to :4900)
just loom-ingest  # Ingest rulebooks from RULES_DIR
just loom-start   # Production (build web + start server)
```

Environment: `.env.loom` (see `.env.loom.example`).
