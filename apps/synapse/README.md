```
███████╗██╗   ██╗███╗   ██╗ █████╗ ██████╗ ███████╗███████╗
██╔════╝╚██╗ ██╔╝████╗  ██║██╔══██╗██╔══██╗██╔════╝██╔════╝
███████╗ ╚████╔╝ ██╔██╗ ██║███████║██████╔╝███████╗█████╗
╚════██║  ╚██╔╝  ██║╚██╗██║██╔══██║██╔═══╝ ╚════██║██╔══╝
███████║   ██║   ██║ ╚████║██║  ██║██║     ███████║███████╗
╚══════╝   ╚═╝   ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝     ╚══════╝╚══════╝
```

> _A synapse fires. The gap between signal and action narrows to nothing. Thought becomes movement._

---

**Synapse** is the execution layer. A paper trading daemon that reads signals from Cortex, sizes positions by confidence, manages risk with stop-losses and drawdown limits, and tracks everything in SQLite. No real money. No custodial keys. Just a simulation running against live market data, learning what its conviction is actually worth.

Think of it as the motor cortex -- the part that turns analysis into action.

## The Wire

```
╔══════════════════════════╗
║        CORTEX            ║
║  signals + prices        ║
║  (read-only, separate db)║
╚════════════╤═════════════╝
             │
   ╔═════════▼═══════════╗
   ║    SIGNAL POLL       ║  every 60s
   ║  filter → size → go  ║
   ╚═════════╤═══════════╝
             │
   ╔═════════▼═══════════╗     ╔══════════════════╗
   ║   PAPER EXECUTOR    ║────▶║   PORTFOLIO       ║
   ║  slippage + gas sim ║     ║  cash, positions,  ║
   ╚═════════════════════╝     ║  trades, snapshots ║
                               ╚═════════╤════════╝
                                         │
   ╔═════════════════════╗               │
   ║    RISK CHECK       ║◀─────────────┘
   ║  stop/TP, drawdown  ║  every 30s
   ╚═════════════════════╝
```

Two loops. One portfolio. Signals flow in, risk flows out.

## Signal Filtering

Not every signal deserves capital. Before a position opens, it runs a gauntlet:

- **Confidence floor** -- short-term signals need 0.40, long-term need 0.60
- **Staleness** -- short-term signals expire after 2h, long-term after 24h
- **Dedup** -- each cortex signal processed exactly once
- **Hold/sell without position** -- discarded silently
- **Portfolio state** -- halted? maxed out? pre-drawdown caution? skip

What survives the filter gets sized and executed. Everything else gets logged with the reason it didn't.

## Position Sizing

Size scales with confidence. Higher conviction = more capital at risk.

```
size_usd = confidence * (portfolio_total * max_position_pct)
```

Defaults to 25% max per position. A 0.60 confidence signal on a $10k portfolio allocates $1,500. Additional gates: minimum trade $50, gas can't exceed 2% of trade size, must have cash on hand.

## Risk Management

The risk loop runs every 30 seconds. It fetches fresh prices from cortex, updates every open position, then enforces:

| Rule              | Default                  | Effect                            |
| ----------------- | ------------------------ | --------------------------------- |
| **Stop-loss**     | 5% (short) / 8% (long)   | Close position, realize loss      |
| **Take-profit**   | 20%                      | Close position, realize gain      |
| **Max drawdown**  | 15% from high-water mark | Close ALL positions, halt trading |
| **Max positions** | 8                        | Block new entries                 |

Drawdown halt is the kill switch. If the portfolio drops 15% from peak, everything closes and the engine stops opening new positions. Impulse control for algorithms.

## Paper Executor

No real trades. The executor:

1. Reads current price from cortex
2. Applies simulated slippage (default 30 bps)
3. Adds flat gas cost ($0.50)
4. Returns fill price and quantity

Realistic enough to expose bad sizing. Cheap enough to run 24/7 without consequence.

## Neural Map

```
src/
├── main.ts                   # daemon init, db connections, start loops
├── env.ts                    # zod-validated config
├── types.ts                  # executor interface
├── engine/
│   ├── loop.ts              # signal poll + risk check cron jobs
│   ├── signal-filter.ts     # confidence, staleness, dedup gates
│   ├── position-sizer.ts    # confidence-scaled allocation
│   ├── risk.ts              # stop/TP, drawdown, position limits
│   ├── executor.ts          # PaperExecutor (slippage + gas sim)
│   └── pricing.ts           # fetch prices from cortex db
├── cortex/
│   ├── reader.ts            # read-only cortex.db connection
│   └── types.ts             # cortex schema (signals, prices, tokens)
├── db/
│   ├── schema.ts            # portfolio, positions, trades, snapshots
│   ├── queries.ts           # CRUD helpers
│   ├── migrate.ts           # migration runner
│   └── migrations/
│       └── 001-initial.ts   # all tables
├── portfolio/
│   └── tracker.ts           # price updates, NAV recalc, snapshots
└── __tests__/
    ├── engine.test.ts        # signal → position, risk → close
    ├── signal-filter.test.ts
    ├── risk.test.ts
    └── position-sizer.test.ts
```

## Data Model

Six tables. Immutable audit trail.

- **portfolio_state** -- singleton row: cash, total value, high-water mark, drawdown %, halted flag
- **positions** -- open and closed: entry/current price, quantity, stop/TP levels, realized + unrealized P&L
- **trades** -- every execution: direction, price, size, gas, slippage
- **snapshots** -- NAV history every 15 minutes
- **signal_log** -- every cortex signal processed, with action taken or skip reason
- **risk_events** -- stop-loss hits, take-profit hits, drawdown halts

## Jacking In

```bash
just synapse-dev              # dev mode, file watching
just synapse-start            # production daemon
just test-synapse             # run tests
```

## Environment

| Variable                     | Default             | Purpose                            |
| ---------------------------- | ------------------- | ---------------------------------- |
| `DATABASE_URL`               | `./data/synapse.db` | Synapse's own database             |
| `CORTEX_DATABASE_URL`        | `./data/cortex.db`  | Read-only cortex connection        |
| `INITIAL_BALANCE_USD`        | `10000`             | Starting cash                      |
| `POLL_INTERVAL`              | `60`                | Signal check interval (seconds)    |
| `RISK_CHECK_INTERVAL`        | `30`                | Risk check interval (seconds)      |
| `MIN_CONFIDENCE_SHORT`       | `0.4`               | Buy threshold (short-term signals) |
| `MIN_CONFIDENCE_LONG`        | `0.6`               | Buy threshold (long-term signals)  |
| `MAX_POSITION_PCT`           | `25`                | Max portfolio % per position       |
| `MAX_PORTFOLIO_DRAWDOWN_PCT` | `15`                | Halt threshold                     |
| `STOP_LOSS_PCT`              | `8`                 | Default stop-loss (long-term)      |
| `TAKE_PROFIT_PCT`            | `20`                | Take-profit target                 |
| `MAX_OPEN_POSITIONS`         | `8`                 | Position limit                     |
| `SLIPPAGE_BPS`               | `30`                | Simulated slippage (basis points)  |
| `SIMULATED_GAS_USD`          | `0.50`              | Flat gas per trade                 |

---

> _"He knew the edge. He'd been there before. The razor-Loss of control, the bleeding of options, the hard certainty that every move mattered."_
>
> -- William Gibson, _Count Zero_

Synapse doesn't predict. It reacts, sizes, and survives. The gap between signal and action, measured in basis points.
