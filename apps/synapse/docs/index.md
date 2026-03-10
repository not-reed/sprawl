---
title: Synapse
description: Paper trading daemon
---

# Synapse

## Overview

Paper trading daemon. Reads signals from Cortex's database, sizes positions by confidence, manages risk with stop-losses and drawdown limits, and simulates execution with slippage and gas costs. No real money -- purely simulation against live data.

## How it works

### Boot sequence (`apps/synapse/src/main.ts`)

1. Run DB migrations (own database)
2. Create Kysely DB + CortexReader (read-only connection to Cortex DB)
3. Initialize portfolio state if first run (set initial cash balance)
4. Create PaperExecutor (simulates fills)
5. Start cron loop daemon

### Engine loop (`apps/synapse/src/engine/loop.ts`)

Two Croner jobs:

- **Signal poll** (default: 60s) -- Reads latest signals from Cortex, filters, sizes, and executes paper trades
- **Risk check** (default: 30s) -- Updates position prices, checks stop-loss/take-profit, monitors portfolio drawdown

### Signal processing flow

```
Cortex signals ──> dedup ──> filter ──> risk check ──> size ──> execute ──> record
```

1. **Dedup** -- Skip signals already in `signal_log`
2. **Filter** (`signal-filter.ts`) -- Confidence thresholds (configurable per short/long), existing position check
3. **Pre-trade risk** (`risk.ts`) -- Portfolio halt check, max open positions, exposure limits
4. **Position sizing** (`position-sizer.ts`) -- Scales USD allocation by confidence against total portfolio value
5. **Execution** (`executor.ts`) -- PaperExecutor applies slippage (BPS) and simulated gas, returns fill price + quantity
6. **Record** -- Insert position, trade, signal log entries. Update cash balance.

### Risk management (`apps/synapse/src/engine/risk.ts`)

Per-position:

- **Stop-loss** -- Configurable percentage below entry (default: 8%). Triggers automatic close.
- **Take-profit** -- Configurable percentage above entry (default: 20%). Triggers automatic close.

Portfolio-level:

- **Drawdown halt** -- If portfolio drops below threshold from high water mark (default: 15%), close all positions and halt trading
- **Exposure limit** -- Max allocation to a single token (default: 25% of NAV)
- **Max open positions** -- Cap on concurrent positions (default: 8)

### Portfolio tracking (`apps/synapse/src/portfolio/tracker.ts`)

- Updates position mark-to-market prices from Cortex
- Recalculates total portfolio value, drawdown, high water mark
- Periodic snapshots for historical tracking

### CLI status (`apps/synapse/src/status.ts`)

`just synapse-status` prints a summary: NAV, cash, drawdown, return %, open positions table, recent trades, risk events.

## Key files

| File                           | Role                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `src/main.ts`                  | Entry point, boot sequence                                                       |
| `src/env.ts`                   | All config: balance, intervals, risk params, sizing                              |
| `src/status.ts`                | CLI portfolio summary                                                            |
| `src/types.ts`                 | Executor interface                                                               |
| `src/cortex/reader.ts`         | Read-only Cortex DB access (signals, prices, tokens)                             |
| `src/engine/loop.ts`           | Signal poll + risk check cron jobs                                               |
| `src/engine/executor.ts`       | PaperExecutor (simulated fills)                                                  |
| `src/engine/signal-filter.ts`  | Confidence filtering, cooldown                                                   |
| `src/engine/position-sizer.ts` | Confidence-scaled allocation                                                     |
| `src/engine/risk.ts`           | Stop-loss, take-profit, drawdown, exposure                                       |
| `src/engine/pricing.ts`        | Price fetching from Cortex                                                       |
| `src/portfolio/tracker.ts`     | Mark-to-market, portfolio recalc, snapshots                                      |
| `src/db/schema.ts`             | positions, trades, signal_log, risk_events, portfolio_state, portfolio_snapshots |

## Database tables

- `portfolio_state` -- Single row: cash_usd, total_value_usd, high_water_mark_usd, drawdown_pct, halted
- `positions` -- Open/closed positions (token, entry/current price, quantity, P&L, stop/take levels)
- `trades` -- Individual buy/sell executions (price, size, gas, slippage)
- `signal_log` -- Every signal processed: action taken (opened, closed, skipped) + reason
- `risk_events` -- Stop-loss, take-profit, drawdown halt, exposure limit events
- `portfolio_snapshots` -- Periodic NAV snapshots for time-series tracking

## Integration points

- **Cortex** -- Reads `signals`, `price_snapshots`, `tracked_tokens` from Cortex DB via CortexReader
- **Optic** -- Reads portfolio_state, positions, trades, signal_log, risk_events via rusqlite
- Does NOT use Cairn -- purely a signal consumer and execution engine
