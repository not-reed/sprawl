```
██╗      ██████╗  ██████╗ ███╗   ███╗
██║     ██╔═══██╗██╔═══██╗████╗ ████║
██║     ██║   ██║██║   ██║██╔████╔██║
██║     ██║   ██║██║   ██║██║╚██╔╝██║
███████╗╚██████╔╝╚██████╔╝██║ ╚═╝ ██║
╚══════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚═╝
```

> _"Stories are spells. You cast them into the dark and something always answers."_

---

**Loom** is a system-agnostic RPG Game Master daemon. It ingests rulebooks into cairn's memory pipeline, tracks campaign state through play, and runs sessions over a streaming chat interface. Rules come from files. Context comes from the table. The GM never forgets a name, a place, or a ruling.

Drop any system's rules in markdown. Loom learns them, recalls them when they matter, and weaves them into the narrative.

## The Loom

```
                ╔═══════════════════╗
                ║    RULES DIR      ║
                ║  .md / .txt files ║
                ╚════════╤══════════╝
                         │ ingest
                         ▼
╔════════════════════════════════════════════════════╗
║                    AI  AGENT                       ║
║                  pi-agent-core                     ║
║                                                    ║
║   ┌──────────────┐  ┌──────────────┐               ║
║   │ rules recall │  │ campaign ctx │               ║
║   │ (top 5 FTS+  │  │ (recent +    │               ║
║   │  embedding)  │  │  semantic)   │               ║
║   └──────────────┘  └──────────────┘               ║
║                                                    ║
║   ┌──────────────┐  ┌──────────────┐               ║
║   │ observations │  │ active msgs  │               ║
║   │ (compressed  │  │ (conv tail)  │               ║
║   │  history)    │  │              │               ║
║   └──────────────┘  └──────────────┘               ║
╚═══════════════════════╤════════════════════════════╝
                        │ SSE stream
╔═══════════════════════▼════════════════════════════╗
║  Hono API + React SPA (mobile-first)               ║
║  campaigns │ sessions │ chat │ observations        ║
╚═══════════════════════╤════════════════════════════╝
                        │ kysely
╔═══════════════════════▼════════════════════════════╗
║  SQLite + Cairn                                    ║
║  memories │ observations │ graph │ campaigns       ║
╚════════════════════════════════════════════════════╝
```

Rules ingested at the top. Context assembled in the middle. Everything persisted at the bottom.

## Modes

| Mode      | Behavior                                                                                 |
| --------- | ---------------------------------------------------------------------------------------- |
| **Play**  | GM narrates in second person, adjudicates rules, calls for dice rolls, waits for results |
| **Recap** | Player describes past events, GM acknowledges and asks clarifying questions              |

Switch modes mid-session. Recap to catch up on off-screen events, then flip to play and roll initiative.

## Context Assembly

Each message weaves context from four sources:

1. **Observations** -- compressed conversation history from cairn's observer/reflector
2. **Rules memories** -- top 5 relevant chunks recalled via hybrid FTS5 + embedding search
3. **Campaign memories** -- recent + semantically relevant non-rules memories
4. **Active messages** -- un-observed conversation tail

The memory pipeline runs async after each response: observe, promote novel observations to searchable memories, reflect when budget is exceeded. The GM accumulates knowledge of the world as you play.

## Dice Protocol

```
GM:  "The shadow lunges. Roll 2d6 + your Cute attribute."
     ── STOP. Wait for result. ──
You: "I got a 9"
GM:  "Your kitty bats the shadow with devastating charm. It dissolves..."
```

The agent states dice, modifiers, and target number, then halts. No phantom rolls. No assumed outcomes.

## Rulebook Ingestion

Drop `.md` or `.txt` files in `rules/`. Run `just loom-ingest`.

- Splits on `##` / `###` headings, preserves heading hierarchy as chunk prefix
- Oversized sections split on paragraph boundaries (~1500 token limit)
- Each chunk gets an embedding + graph extraction (NPCs, locations, items)
- Stored as `category: 'rules'` memories -- searchable via FTS5 and cosine similarity

Any system. Any edition. If it's markdown, the loom can weave it.

## Voice (Kokoro TTS)

Optional. Set `TTS_ENABLED=true` and run Kokoro via Docker:

```bash
cd apps/loom && docker compose up -d
```

Kokoro exposes an OpenAI-compatible `/v1/audio/speech` endpoint at port 8880. After the GM finishes a response, Loom sends the text to Kokoro, caches the audio, and streams an SSE `audio` event with a URL. The frontend auto-plays if the speaker toggle is on, or shows a play button on each GM message.

Narration text is cleaned before synthesis -- markdown, code blocks, and formatting stripped.

## Neural Map

```
src/
├── main.ts               # boot: migrations, db, hono server
├── env.ts                # zod env validation
├── agent.ts              # processMessage() -- context assembly + LLM + cairn
├── system-prompt.ts      # static GM prompt + dynamic preamble builder
├── ingest.ts             # CLI: rules/ → chunks → memories + embeddings + graph
├── server.ts             # hono app: CORS, db middleware, static SPA
├── tts/
│   └── kokoro.ts         # kokoro OpenAI-compatible TTS client
├── db/
│   ├── schema.ts         # cairn tables + campaigns, sessions
│   ├── queries.ts        # campaign/session CRUD
│   ├── migrate.ts        # migration runner
│   └── migrations/       # 001-005 cairn tables, 006 campaigns
└── routes/
    ├── chat.ts           # POST /api/chat (SSE stream), GET history
    ├── audio.ts          # GET /api/audio/:id (cached TTS audio)
    ├── campaigns.ts      # CRUD campaigns + create sessions
    └── sessions.ts       # GET/PATCH sessions, GET observations

web/
├── src/
│   ├── App.tsx           # routes: /, /campaign/:id, /play/:sessionId
│   ├── lib/
│   │   ├── api.ts        # fetch wrappers
│   │   └── types.ts      # shared interfaces
│   ├── hooks/
│   │   ├── useApi.ts     # generic data-fetching
│   │   ├── useChat.ts    # SSE streaming + message state
│   │   └── useSession.ts # session metadata + observations
│   ├── components/
│   │   ├── Layout.tsx         # nav shell
│   │   ├── CampaignList.tsx   # home: list/create campaigns
│   │   ├── CampaignView.tsx   # sessions within campaign
│   │   ├── PlayView.tsx       # chat + sidebar assembled
│   │   ├── ChatPanel.tsx      # message list + auto-scroll
│   │   ├── ChatMessage.tsx    # user/GM bubbles, markdown
│   │   ├── ChatInput.tsx      # auto-growing textarea
│   │   └── SessionSidebar.tsx # observations, mobile drawer
│   └── styles/
│       └── index.css          # mobile-first dark theme
└── vite.config.ts
```

## Jacking In

```bash
just loom-dev          # backend dev (file watching, port 4900)
just loom-web          # frontend dev (Vite, proxies to 4900)
just loom-ingest       # ingest rulebooks from rules/
just loom-start        # production (build web + start server)
```

## Environment

File: `.env.loom` (see `.env.loom.example`)

| Variable              | Purpose                                           |
| --------------------- | ------------------------------------------------- |
| `OPENROUTER_API_KEY`  | LLM uplink (required)                             |
| `OPENROUTER_MODEL`    | Default: `google/gemini-3-flash-preview`          |
| `DATABASE_URL`        | Default: `./data/loom.db`                         |
| `PORT`                | Default: `4900`                                   |
| `EMBEDDING_MODEL`     | Default: `qwen/qwen3-embedding-4b`                |
| `MEMORY_WORKER_MODEL` | Dedicated model for observer/reflector (optional) |
| `TIMEZONE`            | Default: `UTC`                                    |
| `RULES_DIR`           | Default: `./rules`                                |
| `TTS_ENABLED`         | Enable Kokoro TTS (default: `false`)              |
| `KOKORO_URL`          | Default: `http://localhost:8880`                  |
| `KOKORO_VOICE`        | Default: `af_heart`                               |

---

> _"The street finds its own uses for things -- and so does every table of players who ever house-ruled a critical hit."_
>
> -- loosely after Gibson

The loom weaves. The story holds.
