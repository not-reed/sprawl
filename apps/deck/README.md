```
██████╗ ███████╗ ██████╗██╗  ██╗
██╔══██╗██╔════╝██╔════╝██║ ██╔╝
██║  ██║█████╗  ██║     █████╔╝
██║  ██║██╔══╝  ██║     ██╔═██╗
██████╔╝███████╗╚██████╗██║  ██╗
╚═════╝ ╚══════╝ ╚═════╝╚═╝  ╚═╝
```

> *The matrix has its own landscape -- a drastic simplification of the human sensorium. But you can learn to read it.*

---

**Deck** is the observability layer. A web UI for navigating the knowledge graph, searching memories, and tracing the observation pipeline. D3-force visualization on canvas, Hono API on the backend, React on the front. You see what the construct sees.

## Interface

```
┌────────────────────────────────────────────────────────────────────┐
│  [Graph]  [Memories]  [Observations]       847 memories  234 nodes│
├──────────────────────────────────────────┬─────────────────────────┤
│                                          │  BITCOIN                │
│            ╭─ ethereum                   │  person                 │
│      SEC ──┤                             │                         │
│            ╰─ coinbase                   │  Connections:           │
│                    ╲                     │  ──▸ trades_on  Binance │
│          solana ─── bitcoin ─── binance  │  ──▸ competes   Ether.. │
│                    ╱                     │  ◂── regulates  SEC     │
│              defi ╱                      │                         │
│                                          │  Linked Memories:       │
│     [type filters]  [search]  [reset]    │  "BTC broke $95k..."   │
├──────────────────────────────────────────┴─────────────────────────┤
│  pan: drag │ zoom: scroll │ select: click │ expand: double-click   │
└────────────────────────────────────────────────────────────────────┘
```

Three views. One database. Everything cross-linked.

## Graph View

Interactive D3-force simulation rendered on canvas. Not SVG -- canvas, for performance.

- **Initial load** -- top 200 nodes + all edges between them
- **Click** -- select node, load edges + linked memories in side panel
- **Double-click** -- expand: traverse depth=2 from node, merge new data into graph
- **Drag** -- pin node position; simulation restarts at lower alpha
- **Pan/Zoom** -- drag background, scroll wheel
- **Type filters** -- toggle person / place / concept / event / entity
- **Search** -- find by name, focus if present, expand if not
- **URL state** -- `?node=<id>` for deep links

Node radius scales with edge count. Colors by type. Selected nodes glow. Labels appear on zoom or when a node is large enough to matter.

## Memory Browser

Full-text + semantic search over the memory store.

| Mode | Engine | Speed |
|---|---|---|
| `auto` | Embedding + FTS fallback | Default |
| `fts` | SQLite FTS5 | Fast |
| `embedding` | OpenRouter cosine similarity | Semantic |
| `keyword` | LIKE matching | Simple |

Memory cards expand to show content, metadata, tags, source. Click through to linked graph nodes. Jump to graph view with `?node=<id>`.

## Observation Timeline

Conversation-centric view of the observer pipeline output. Select a conversation, see its extracted facts ordered by date. Toggle superseded observations to trace how facts evolve across reflector generations.

Priority badges (low/medium/high), generation numbers, token counts, superseded timestamps.

## The Wire

```
╔══════════════════════════════════════════════════════════╗
║  React 19 + React Router 7                              ║
║  D3-force canvas │ useGraph │ useSearch │ useApi         ║
╚═══════════════════════╤══════════════════════════════════╝
                        │ fetch /api/*
╔═══════════════════════▼══════════════════════════════════╗
║  Hono API Server                                        ║
║                                                         ║
║  /api/memories   search, recent, get, nodes             ║
║  /api/graph      nodes, edges, traverse, full           ║
║  /api/observations   conversations, timeline            ║
║  /api/stats      counts, categories, daily trends       ║
╚═══════════════════════╤══════════════════════════════════╝
                        │ kysely
╔═══════════════════════▼══════════════════════════════════╗
║  SQLite (construct's memory store)                      ║
║  memories │ graph_nodes │ graph_edges │ observations     ║
╚══════════════════════════════════════════════════════════╝
```

## Neural Map

```
src/
├── server.ts             # hono app, CORS, static serving, db injection
├── env.ts                # DATABASE_URL, PORT, OPENROUTER_API_KEY, EMBEDDING_MODEL
└── routes/
    ├── memories.ts       # search (3 modes), recent, get, linked nodes
    ├── graph.ts          # node search, edges, traversal, full dump
    ├── observations.ts   # conversations list, observation timeline
    └── stats.ts          # aggregate counts + daily trends

web/
├── src/
│   ├── App.tsx           # router setup
│   ├── lib/
│   │   ├── api.ts        # fetch client
│   │   ├── types.ts      # shared interfaces
│   │   └── graph-layout.ts   # d3-force config, node styling
│   ├── hooks/
│   │   ├── useGraph.ts   # graph state, selection, simulation
│   │   ├── useSearch.ts  # memory search state
│   │   └── useApi.ts     # generic fetch + loading/error
│   └── components/
│       ├── GraphView.tsx         # canvas renderer
│       ├── GraphControls.tsx     # filters, search, reset
│       ├── GraphDetail.tsx       # side panel (connections + memories)
│       ├── MemoryBrowser.tsx     # search + results list
│       ├── MemoryCard.tsx        # expandable card + linked nodes
│       ├── ObservationTimeline.tsx  # conversation picker + timeline
│       └── Layout.tsx            # nav + stats
└── vite.config.ts
```

## Jacking In

```bash
pnpm start                # boot hono server on :4800
pnpm typecheck            # static analysis
cd web && pnpm dev        # vite dev server for frontend
cd web && pnpm build      # build to web/dist/ (served by hono in prod)
```

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Path to construct's SQLite database |
| `OPENROUTER_API_KEY` | Embedding search (optional -- falls back to FTS) |
| `EMBEDDING_MODEL` | Default: `qwen/qwen3-embedding-4b` |
| `PORT` | Default: `4800` |

---

> *"He closed his eyes. Found the ridged face of the power stud. And in the bloodlit dark behind his eyes, silver phosphenes boiling in from the edge of space, hypnagogic images jerking past like film compiled from random frames."*
>
> -- William Gibson, *Neuromancer*

Deck is the screen behind your eyes. The graph is already there. This just lets you see it.
