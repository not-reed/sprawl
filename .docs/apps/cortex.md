# Cortex

*Last updated: 2026-03-01 -- Initial documentation*

## Overview

Crypto market intelligence daemon. Runs as a headless Node.js process that ingests prices and news on cron loops, feeds them through Cairn's memory pipeline, and generates LLM-grounded trading signals. Stores everything in its own SQLite database.

## How it works

### Boot sequence (`apps/cortex/src/main.ts`)

1. Run DB migrations
2. Create Kysely DB + MemoryManager (Cairn)
3. Seed tracked tokens from CoinGecko (fetch metadata)
4. If `--backfill` flag: run historical backfill, then exit (or continue with `--daemon`)
5. Fetch initial prices
6. Start cron loop daemon

### Pipeline loop (`apps/cortex/src/pipeline/loop.ts`)

Three Croner jobs run on configurable intervals:

- **Price ingestion** (default: 5min) -- Fetches current prices from CoinGecko, stores snapshots, composes a price message for Cairn, runs observer -> promoter -> reflector pipeline
- **News ingestion** (default: 15min) -- Fetches news from CryptoPanic + CryptoCompare RSS, deduplicates by external_id, composes news message for Cairn pipeline
- **Signal generation** (default: 1hr) -- Runs `analyzeAllTokens()` for each tracked token

A fourth job polls a **command queue** every 10s. Optic can insert commands (e.g. "analyze") which Cortex picks up and executes.

### Signal analyzer (`apps/cortex/src/pipeline/analyzer.ts`)

For each token, generates two signals: **short-term** (24h) and **long-term** (4 weeks).

1. Generate a recall query via LLM (or static fallback)
2. Hybrid memory recall: FTS5 + embedding similarity (15 memories)
3. Graph context: search nodes by token name, traverse 2 hops, fetch linked memories
4. Compose prompt with price data, memories, graph context
5. LLM generates structured signal: `{ signal: buy|sell|hold, confidence: 0-1, reasoning, key_factors }`
6. Store signal in `signals` table
7. Store signal reasoning as a Cairn memory (feedback loop)

### Data flow

```
CoinGecko ─────────> price_snapshots ─────> analyzer ─────> signals
                                               ↑               │
CryptoPanic ────┐                              │               │
CryptoCompare ──┴─> news_items                 │               ↓
                        │                      │         Synapse reads
                        ↓                      │
                  Cairn pipeline               │
                  (observe → promote →         │
                   reflect → graph)  ──────────┘
                        │
                     memories + graph_nodes + graph_edges
```

### Backfill (`apps/cortex/src/pipeline/backfill.ts`)

Supports `--backfill`, `--backfill-news`, `--backfill-prices` flags with a day count. Historical data is fetched and run through the same Cairn pipeline, building up the memory/graph substrate before live operation.

## Key files

| File | Role |
|------|------|
| `src/main.ts` | Entry point, CLI args, boot |
| `src/env.ts` | Zod-validated env config |
| `src/pipeline/loop.ts` | Croner jobs, price/news composition |
| `src/pipeline/analyzer.ts` | LLM signal generation with memory recall |
| `src/pipeline/prompts.ts` | Short/long signal prompt templates |
| `src/pipeline/backfill.ts` | Historical data backfill |
| `src/ingest/prices.ts` | CoinGecko API |
| `src/ingest/news.ts` | CryptoPanic + CryptoCompare RSS |
| `src/db/schema.ts` | tracked_tokens, price_snapshots, news_items, signals, commands |
| `src/db/queries.ts` | All DB operations |

## Database tables

- `tracked_tokens` -- Token metadata (id, symbol, name, active flag)
- `price_snapshots` -- Time-series price data (price, market_cap, volume, change_24h/7d)
- `news_items` -- Deduplicated news articles (external_id, title, url, source, tokens_mentioned)
- `signals` -- Generated trading signals (token_id, signal_type, confidence, reasoning, timeframe)
- `commands` -- Queue for inter-app commands (Optic -> Cortex)
- Plus Cairn tables: memories, observations, graph_nodes, graph_edges, conversations, messages

## Integration points

- **Cairn** (`@repo/cairn`) -- Memory pipeline for price + news data. Same observe/reflect/promote/graph flow used by Construct.
- **Synapse** -- Reads `signals` table from Cortex's DB via CortexReader
- **Optic** -- Reads price_snapshots, news_items, signals, graph_* tables directly via rusqlite. Can insert commands.
- **Deck** -- Can browse Cortex's memory graph if pointed at its DB

## Related documentation

- [Cairn](../packages/cairn.md) -- Memory pipeline details
- [Synapse](./synapse.md) -- Signal consumer
- [Optic](./optic.md) -- Market data visualization
