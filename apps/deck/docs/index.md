---
title: Deck
description: Memory graph explorer
---

# Deck

## Overview

Memory graph explorer. A Hono REST API serving a React SPA that visualizes the knowledge graph, lets you browse memories, and trace the observation pipeline. Can point at any Sprawl app's database.

## How it works

### Backend (`apps/deck/src/server.ts`)

Hono app with CORS, DB injection middleware, and four route groups:

- `/api/memories` -- Search, list, detail for the `memories` table
- `/api/graph` -- Nodes, edges, traversal queries against `graph_nodes`/`graph_edges`
- `/api/observations` -- Timeline of observation pipeline activity
- `/api/stats` -- Aggregate counts (memories, nodes, edges, etc.)

In production, serves the built React SPA from `web/dist/`. In development, use Vite dev server + API proxy.

### Frontend (`apps/deck/web/`)

React 19 SPA with React Router. Three views:

- **GraphView** (`/`) -- D3-force directed graph on HTML canvas. Nodes are entities, edges are relationships. Click to inspect, search to filter.
- **MemoryBrowser** (`/memories`) -- Searchable list of all memories with category/source filters.
- **ObservationTimeline** (`/observations`) -- Chronological view of observations, showing generation, priority, and supersession.

### Components

| Component                 | Role                                                |
| ------------------------- | --------------------------------------------------- |
| `GraphView.tsx`           | D3-force canvas rendering, zoom/pan, node selection |
| `GraphControls.tsx`       | Search, layout controls                             |
| `GraphDetail.tsx`         | Selected node/edge detail panel                     |
| `NodeTooltip.tsx`         | Hover tooltip for graph nodes                       |
| `MemoryBrowser.tsx`       | Memory list with search                             |
| `MemoryCard.tsx`          | Individual memory display                           |
| `ObservationTimeline.tsx` | Observation list with generation/priority display   |
| `SearchBar.tsx`           | Shared search input                                 |
| `Layout.tsx`              | App shell with navigation                           |

## Key files

| File                               | Role                                |
| ---------------------------------- | ----------------------------------- |
| `src/server.ts`                    | Hono app setup, middleware, routing |
| `src/env.ts`                       | DATABASE_URL + PORT config          |
| `src/routes/memories.ts`           | Memory search/list/detail API       |
| `src/routes/graph.ts`              | Graph query API                     |
| `src/routes/observations.ts`       | Observation timeline API            |
| `src/routes/stats.ts`              | Stats aggregation API               |
| `web/src/App.tsx`                  | React router setup                  |
| `web/src/components/GraphView.tsx` | D3-force graph visualization        |

## Integration points

- **@repo/cairn** -- Uses `CairnDatabase` type for DB queries. Reads memories, observations, graph_nodes, graph_edges tables.
- **@repo/db** -- `createDb()` for database connection.
- Can browse any Sprawl app's database (Construct, Cortex) by changing `DATABASE_URL`.

## Running

```bash
just deck-dev myinstance    # reads .env.myinstance for DATABASE_URL
```

Default port: 4800.
