# Deck

Memory graph explorer. Hono API server + React SPA for browsing cairn memories, graph, and observations.

## Key Files

- `src/server.ts` -- Hono app: CORS, DB injection middleware, static serving, route mounting
- `src/routes/graph.ts` -- `/api/graph` (node search, node detail, edges, traversal)
- `src/routes/memories.ts` -- `/api/memories` (search, list, detail)
- `src/routes/observations.ts` -- `/api/observations` (timeline)
- `src/routes/stats.ts` -- `/api/stats` (counts)
- `src/env.ts` -- `DATABASE_URL`, `PORT`
- `web/src/App.tsx` -- React SPA routes
- `web/src/components/GraphView.tsx` -- D3-force canvas graph visualization

## Architecture

```
Hono server (server.ts)
  ├── Middleware: CORS + DB injection (Kysely<CairnDatabase>)
  ├── /api/memories    → memories.ts (FTS search, list, detail)
  ├── /api/graph       → graph.ts (node search, edges, traversal)
  ├── /api/observations → observations.ts (timeline)
  ├── /api/stats       → stats.ts (counts)
  └── Static: web/dist/ (production only)

React SPA (web/)
  ├── / → GraphView (D3-force canvas)
  ├── /memories → MemoryBrowser
  └── /observations → ObservationTimeline
```

Deck reads any cairn-compatible SQLite DB. It imports cairn query functions directly (`searchNodes`, `traverseGraph`, etc.) rather than reimplementing queries.

## Directory Structure

```
src/
├── server.ts            # Hono app + middleware
├── env.ts               # DATABASE_URL, PORT
└── routes/
    ├── memories.ts
    ├── graph.ts
    ├── observations.ts
    └── stats.ts

web/                     # React SPA (Vite)
└── src/
    ├── App.tsx
    └── components/
        ├── GraphView.tsx         # D3-force canvas
        ├── MemoryBrowser.tsx
        └── ObservationTimeline.tsx
```

## Adding a Route

1. Create `src/routes/my-route.ts`:

   ```typescript
   import { Hono } from "hono";
   import type { Env } from "../server.js";

   export const myRoutes = new Hono<Env>();

   myRoutes.get("/", async (c) => {
     const db = c.get("db"); // Kysely<CairnDatabase>
     // ...
     return c.json({ data });
   });
   ```

2. Mount in `src/server.ts`: `app.route('/api/my-thing', myRoutes)`

## Dev Mode

```bash
just deck-dev <instance>   # Starts Hono server with .env.<instance>
cd apps/deck/web && pnpm dev  # Vite dev server for React SPA (separate terminal)
```

## Environment Variables

File: `.env.<instance>` (e.g. `.env.construct` since it reads construct's DB)

- `DATABASE_URL` -- SQLite DB to browse (default: `./data/construct.db`)
- `PORT` -- Server port (default: `4800`)
