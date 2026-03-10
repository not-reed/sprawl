# Synapse

Paper trading daemon. Reads Cortex signals, filters by confidence/timeframe, sizes positions, manages risk, simulates execution.

## Key Files

- `src/main.ts` -- Boot: migrations, DB + CortexReader, portfolio init, PaperExecutor, loop
- `src/engine/loop.ts` -- Cron jobs: signal polling + risk checking
- `src/engine/signal-filter.ts` -- Confidence thresholds, staleness, cooldown, dedup
- `src/engine/position-sizer.ts` -- Kelly-inspired sizing by confidence
- `src/engine/risk.ts` -- Stop-loss, take-profit, drawdown halt, exposure limits
- `src/engine/executor.ts` -- `PaperExecutor` (simulated fills with slippage + gas)
- `src/cortex/reader.ts` -- Read-only access to Cortex DB
- `src/portfolio/tracker.ts` -- Position price updates, portfolio recalc, snapshots
- `src/errors.ts` -- `ExecutionError`, `RiskError`

## Architecture

```
Cron scheduler (loop.ts)
  ├── Signal poll (POLL_INTERVAL)
  │     cortex.getNewSignals()
  │     → filterSignal (confidence, staleness, dedup)
  │     → canOpenPosition (max positions, drawdown halt)
  │     → checkExposureLimit
  │     → computePositionSize (Kelly-based)
  │     → executor.buy/sell (PaperExecutor)
  │     → insertPosition + insertTrade + logSignal
  │
  └── Risk check (RISK_CHECK_INTERVAL)
        updatePositionPrices (from Cortex DB)
        → checkPositionRisk (stop-loss, take-profit per position)
        → checkPortfolioRisk (drawdown halt)
        → recalculatePortfolio
        → maybeSnapshot
```

Synapse has its own DB for positions/trades but reads prices and signals from Cortex's DB via `CortexReader` (separate read-only Kysely connection).

## Directory Structure

```
src/
├── main.ts
├── env.ts               # Risk params, position sizing, intervals
├── errors.ts            # ExecutionError, RiskError
├── status.ts            # CLI portfolio summary
├── types.ts             # Executor interface
├── cortex/
│   ├── reader.ts        # CortexReader (read-only Cortex DB access)
│   └── types.ts         # CortexSignal type
├── engine/
│   ├── loop.ts          # Cron orchestration
│   ├── executor.ts      # PaperExecutor
│   ├── signal-filter.ts # Signal filtering logic
│   ├── position-sizer.ts
│   ├── risk.ts          # Risk management
│   └── pricing.ts       # Price fetching from Cortex DB
├── portfolio/
│   └── tracker.ts       # Position/portfolio updates
└── db/
    ├── schema.ts        # positions, trades, signal_log, risk_events, portfolio_state
    ├── queries.ts
    └── migrations/      # 001
```

## Testing

```bash
just test-synapse
```

- Fixtures: `src/__tests__/fixtures.ts`
  - `createTestPosition()`, `createTestTrade()`, `createTestSignal()`
  - `createTestPortfolioState()`, `createTestExecutionResult()`
  - `createTestSignalLog()`, `createTestRiskEvent()`
  - `createTestEnv()` -- full Env with sensible defaults

## Common Tasks

### Adding a Risk Check

1. Add check function in `src/engine/risk.ts`
2. Wire into risk check loop in `src/engine/loop.ts`
3. Log events via `logRiskEvent()` in `src/db/queries.ts`

### Adding a Migration

1. Create `src/db/migrations/NNN-description.ts` (next: 002)
2. Import in `src/db/migrate.ts`
3. Update `src/db/schema.ts`

## Environment Variables

File: `.env.synapse`

All optional (have defaults):

- `CORTEX_DATABASE_URL` -- Cortex DB to read (default: `./data/cortex.db`)
- `DATABASE_URL` -- Synapse DB (default: `./data/synapse.db`)
- `INITIAL_BALANCE_USD` -- Starting balance (default: `10000`)
- `MIN_CONFIDENCE_SHORT` / `MIN_CONFIDENCE_LONG` -- Signal thresholds
- `MAX_POSITION_PCT` / `MAX_PORTFOLIO_DRAWDOWN_PCT` -- Risk limits
- `STOP_LOSS_PCT` / `TAKE_PROFIT_PCT` -- Per-position limits
- `SLIPPAGE_BPS` / `SIMULATED_GAS_USD` -- Execution simulation
