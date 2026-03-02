# Optic

*Last updated: 2026-03-01 -- Initial documentation*

## Overview

Terminal trading dashboard. A Rust TUI built with Ratatui that reads Cortex and Synapse SQLite databases directly via rusqlite. No JS runtime, no network calls -- just local DB reads.

## How it works

### Startup (`apps/optic/src/main.rs`)

1. Parse CLI args: first positional arg = Cortex DB path, `--synapse <path>` = Synapse DB path
2. Open CortexDb (required) and optionally SynapseDb
3. Initial data refresh
4. Enter Crossterm alternate screen, start event loop

### Event loop

- Auto-refreshes every 5 seconds
- Polls for keyboard events between refreshes
- Modal popups for news detail and signal detail

### View modes

**Market view** (`1` key):
- **Prices table** -- Token symbols, current price, 24h/7d change, volume
- **Price chart** -- Braille-rendered 24h sparkline (cycle tokens with `c`)
- **News feed** -- Scrollable list with source, time, linked tokens. Enter for detail modal, `o` to open URL.
- **Signals** -- Buy/sell/hold with confidence, timeframe (24h/4w), reasoning preview. Enter for detail modal.
- **Knowledge graph** -- Recent edges: source -> relation -> target with weight

**Trading view** (`2` key, requires Synapse connection):
- **Positions** -- Open positions with entry/current price, size, unrealized P&L, stop-loss/take-profit
- **Trades** -- Recent buy/sell executions
- **Signal log** -- Every signal processed: opened, closed, or skipped with reason
- **Risk events** -- Stop-loss, take-profit, drawdown halt events

**Portfolio bar** (shown when Synapse connected):
- NAV, cash, drawdown %, return %, HALTED/LIVE status

### Keybinds

| Key | Action |
|-----|--------|
| `q` | Quit |
| `r` | Manual refresh |
| `Tab` | Cycle focused panel |
| `j/k` or arrows | Scroll |
| `c` | Cycle price chart token (market view) |
| `Enter` | Detail modal (news/signals) |
| `o` | Open news URL in browser (in detail modal) |
| `a` | Queue analyze command for Cortex |
| `1` | Market view |
| `2` | Trading view |
| `Esc` | Close modal |

### Command queue

Pressing `a` inserts an "analyze" command into Cortex's `commands` table. Cortex picks it up on its next command poll (every 10s) and runs signal analysis. Status shows in the status bar.

## Key files

| File | Role |
|------|------|
| `src/main.rs` | CLI args, DB connections, terminal setup, event loop |
| `src/db.rs` | CortexDb + SynapseDb structs. Read-only rusqlite queries. |
| `src/ui.rs` | All Ratatui rendering: panels, tables, charts, modals, status bar |

## Database access

Optic reads databases **read-only** and never writes (except the command queue insert):

**From Cortex DB** (`CortexDb`):
- `tracked_tokens` -- Token symbols
- `price_snapshots` -- Current + historical prices
- `news_items` -- News articles
- `signals` -- Trading signals
- `graph_nodes` + `graph_edges` -- Knowledge graph
- `memories` -- Memory counts for stats
- `commands` -- Insert analyze commands

**From Synapse DB** (`SynapseDb`):
- `portfolio_state` -- NAV, cash, drawdown
- `positions` -- Open positions
- `trades` -- Recent trades
- `signal_log` -- Signal processing history
- `risk_events` -- Risk management events

## Building

```bash
just optic                    # Run (debug build)
just optic-build              # Release build
```

Dependencies: Rust toolchain, `sqlite3` system library (or bundled via rusqlite feature).

## Related documentation

- [Cortex](./cortex.md) -- Market data source
- [Synapse](./synapse.md) -- Trading data source
