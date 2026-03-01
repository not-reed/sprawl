```
 ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗
██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝
██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝
██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗
╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗
 ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝
```

> *The market is a living thing. A vast nervous system of price signals, rumor propagation, and herd behavior. Cortex taps the wire, builds memories, and watches for patterns the way a street samurai watches for movement in peripheral vision.*

---

**Cortex** is a crypto market intelligence daemon. It ingests prices and news on cron loops, feeds them through cairn's memory pipeline, builds a knowledge graph of market entities, and generates trading signals grounded in accumulated context -- not vibes.

All of it rendered in a blessed TUI that looks like it belongs on a Hosaka deck.

## The Wire

```
╔═══════════════════╗  ╔═══════════════════╗  ╔═══════════════════╗
║    COINGECKO      ║  ║   CRYPTOPANIC     ║  ║    RSS FEEDS      ║
║  prices + history ║  ║   news + alerts   ║  ║  coindesk, etc.   ║
╚═════════╤═════════╝  ╚═════════╤═════════╝  ╚═════════╤═════════╝
          │                      │                      │
          └──────────────────────┼──────────────────────┘
                                 │
                    ╔════════════▼════════════╗
                    ║     INGEST LAYER        ║
                    ║  dedup, rate-limit,     ║
                    ║  exponential backoff    ║
                    ╚════════════╤════════════╝
                                 │
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
  ╔═══════════════╗    ╔═══════════════╗    ╔═══════════════════╗
  ║   PRICES      ║    ║    NEWS       ║    ║    ANALYZER       ║
  ║   cron 5m     ║    ║   cron 15m    ║    ║    cron 1h        ║
  ╚═══════╤═══════╝    ╚═══════╤═══════╝    ╚═══════╤═══════════╝
          │                    │                     │
          └────────────────────┼─────────────────────┘
                               │
                    ╔══════════▼═══════════╗
                    ║      CAIRN           ║
                    ║  observe → reflect   ║
                    ║  promote → graph     ║
                    ╚══════════╤═══════════╝
                               │
                    ╔══════════▼═══════════╗
                    ║     SQLITE + TUI     ║
                    ╚══════════════════════╝
```

Three data streams. Three cron loops. One memory pipeline. Everything converges in cairn.

## Ingestion

**Prices** -- CoinGecko `/simple/price` endpoint. Batch fetch for all tracked tokens. 24h and 7d change, volume, market cap. Rate-limited with exponential backoff on 429s.

**News** -- CryptoPanic API primary, RSS feeds (CoinDesk, Cointelegraph) supplemental. Deduped by title hash and external ID. Token mention extraction via regex patterns.

**Historical Backfill** -- `--backfill N` flag hydrates N days of history on cold start. Chunks into weekly batches, runs cairn pipeline every 3 weeks to hit observer token thresholds without spamming LLM calls. Idempotent -- checks for processed week markers.

## Signal Generation

The analyzer doesn't guess. It builds context first, then asks.

1. **Hybrid recall** -- FTS5 + embedding search for token-related memories (limit 15)
2. **Graph traversal** -- Search nodes by token name, traverse 2 hops, fetch linked memories
3. **Evidence-based confidence** -- Capped by memory count, not LLM conviction:
   - < 5 memories: max 0.50
   - < 20 memories: max 0.75
   - >= 20 memories: max 1.00
4. **LLM synthesis** -- Inject memories + graph context + current price data. Output: buy/sell/hold + confidence + reasoning + key factors
5. **Feedback loop** -- Signal reasoning stored as cairn memory for future context

Thin data = low confidence. That's a feature.

## The Deck (TUI)

```
┌─────────────────────────┬───────────────────────────────────────┐
│  PRICES                 │  SIGNALS                              │
│  Token  Price  24h  7d  │  BTC  BUY   0.72  momentum + volume  │
│  BTC    $97k  +2.1% ... │  ETH  HOLD  0.45  consolidating...   │
│  ETH    $3.2k -0.4% ... │  SOL  SELL  0.38  thin evidence...   │
├─────────────────────────┤                                       │
│  ▁▃▅▇█▆▄▃▅▇ (24h)      │                                       │
├─────────────────────────┼───────────────────────────────────────┤
│  NEWS FEED              │  GRAPH                                │
│  02-27 14:30 Bitcoin    │  Bitcoin ──▸ trades_on ◂── Binance   │
│  ● [BTC] ETF inflows... │  Ethereum ──▸ competes ◂── Solana   │
│  ~ [ETH,SOL] DeFi...   │  SEC ──▸ regulates ◂── Coinbase     │
├─────────────────────────┴───────────────────────────────────────┤
│  14:32:01 │ 847 memories │ 234 nodes │ q:quit r:refresh a:run  │
└─────────────────────────────────────────────────────────────────┘
```

blessed + blessed-contrib. 12x12 grid. Auto-refresh every 30s.

- **Prices** -- table with colored percentages + sparkline strip for 24h history
- **News** -- feed with timestamps, token tags, memory link indicators (● linked, ~ pending)
- **Signals** -- color-coded (green/red/yellow), confidence scores, reasoning excerpts
- **Graph** -- entity relationships with directional arrows and edge weights
- **Status** -- live counts, clock, keybinds

## Dual Conversation Streams

Prices and news feed into separate cairn conversations (`cortex:prices`, `cortex:news`). Price trends and narrative context build independently. The analyzer queries both when generating signals.

## Neural Map

```
src/
├── main.ts               # boot, backfill, loop, TUI
├── env.ts                # zod-validated config
├── ingest/
│   ├── prices.ts         # CoinGecko client + backoff
│   ├── news.ts           # CryptoPanic + RSS aggregation
│   └── types.ts          # PriceData, NewsData, HistoricalPricePoint
├── pipeline/
│   ├── loop.ts           # 3 cron jobs (prices/news/signals)
│   ├── backfill.ts       # historical hydration
│   ├── analyzer.ts       # signal generation (hybrid recall + LLM)
│   └── prompts.ts        # signal prompt template
├── tui/
│   ├── index.ts          # blessed screen + grid layout
│   └── widgets/          # prices, news, signals, graph, status
└── db/
    ├── schema.ts         # extends CairnDatabase
    ├── queries.ts         # token, price, news, signal ops
    └── migrations/       # additive only
```

## Jacking In

```bash
pnpm start                      # boot the daemon
pnpm start -- --backfill 30     # hydrate 30 days of history first
pnpm start -- --tui             # blessed TUI mode
pnpm typecheck                  # static analysis
```

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite path |
| `OPENROUTER_API_KEY` | LLM uplink for signals + embeddings |
| `COINGECKO_API_KEY` | Price data (optional, higher rate limits) |
| `CRYPTOPANIC_API_KEY` | News feed |
| `TRACKED_TOKENS` | Comma-separated CoinGecko IDs |
| `EMBEDDING_MODEL` | Default: `qwen/qwen3-embedding-4b` |
| `SIGNAL_MODEL` | Default: `google/gemini-3-flash` |

---

> *"Cyberspace. A consensual hallucination experienced daily by billions of legitimate operators, in every nation."*
>
> -- William Gibson, *Neuromancer*

Cortex watches the consensual hallucination of the market. It doesn't predict the future. It remembers the past well enough to notice when something changes.
