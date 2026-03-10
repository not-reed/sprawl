# Cortex

Crypto market intelligence daemon. Ingests prices + news, generates LLM-powered buy/sell/hold signals via hybrid memory recall.

## Key Files

- `src/main.ts` -- Boot, migrations, token seeding, backfill mode detection, daemon start
- `src/pipeline/loop.ts` -- Cron jobs: price ingestion, news ingestion, signal generation, command queue
- `src/pipeline/analyzer.ts` -- `analyzeAllTokens()`: hybrid recall + graph context + LLM signal generation
- `src/pipeline/prompts.ts` -- Short-term (24h) and long-term (4w) signal prompt templates
- `src/pipeline/backfill.ts` -- Historical data backfill
- `src/ingest/prices.ts` -- CoinGecko price fetching
- `src/ingest/news.ts` -- CryptoPanic + CryptoCompare RSS
- `src/errors.ts` -- `IngestError`, `AnalyzerError`

## Architecture

```
Cron scheduler (loop.ts)
  ├── Price ingestion (PRICE_INTERVAL)
  │     fetchPrices → insertPriceSnapshot → store as cairn memory
  ├── News ingestion (NEWS_INTERVAL)
  │     fetchNews → dedup → insertNewsItem → store as cairn memory
  ├── Signal generation (SIGNAL_INTERVAL)
  │     per token × per timeframe (short/long):
  │       recallMemories (FTS + embeddings) → graph context → LLM → insertSignal
  └── Command queue polling
        getPendingCommands → execute → markComplete
```

Each ingested price/news item is also stored as a cairn memory, creating a feedback loop where the analyzer can recall past market data contextually.

## Directory Structure

```
src/
├── main.ts
├── env.ts               # TRACKED_TOKENS, intervals, API keys
├── errors.ts            # IngestError, AnalyzerError
├── logger.ts
├── ingest/
│   ├── prices.ts        # CoinGecko API
│   ├── news.ts          # CryptoPanic + CryptoCompare
│   └── types.ts         # PriceData, NewsData
├── pipeline/
│   ├── loop.ts          # Cron orchestration
│   ├── analyzer.ts      # LLM signal generation
│   ├── prompts.ts       # Signal prompt templates
│   └── backfill.ts      # Historical backfill
└── db/
    ├── schema.ts        # tracked_tokens, price_snapshots, news_items, signals, commands
    ├── queries.ts
    └── migrations/      # 001-005
```

## Testing

```bash
# No dedicated test command yet -- cortex tests run via `just test`
```

- Fixtures: `src/__tests__/fixtures.ts`
  - `createTestTrackedToken()`, `createTestPriceSnapshot()`, `createTestSignal()`
  - `createTestNewsItem()`, `createTestCommand()`
  - `createTestPriceData()`, `createTestNewsData()` (runtime ingest types)

## Adding a Data Source

1. Create `src/ingest/my-source.ts` with fetch function returning typed data
2. Add ingest types to `src/ingest/types.ts`
3. Add DB storage in `src/db/queries.ts` if new table needed
4. Wire into `src/pipeline/loop.ts` as a new cron job
5. Optionally store as cairn memory for analyzer context

## Adding a Migration

1. Create `src/db/migrations/NNN-description.ts` (next: 006)
2. Import in `src/db/migrate.ts`
3. Update `src/db/schema.ts`

## Environment Variables

File: `.env.cortex`

**Required**: `OPENROUTER_API_KEY`

**Key optional**:

- `DATABASE_URL` -- default: `./data/cortex.db`
- `TRACKED_TOKENS` -- Comma-separated CoinGecko IDs (default: `bitcoin,ethereum`)
- `CRYPTOPANIC_API_KEY` / `CRYPTOCOMPARE_API_KEY` -- News sources
- `PRICE_INTERVAL` / `NEWS_INTERVAL` / `SIGNAL_INTERVAL` -- Seconds between cycles
- `ANALYZER_MODEL` -- LLM for signal generation
