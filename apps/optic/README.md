```
 ██████╗ ██████╗ ████████╗██╗ ██████╗
██╔═══██╗██╔══██╗╚══██╔══╝██║██╔════╝
██║   ██║██████╔╝   ██║   ██║██║
██║   ██║██╔═══╝    ██║   ██║██║
╚██████╔╝██║        ██║   ██║╚██████╗
 ╚═════╝ ╚═╝        ╚═╝   ╚═╝ ╚═════╝
```

> *All the data in the world lives behind glass. The trick is knowing which pane to look through.*

---

Terminal interface for the trading pipeline. Reads from Cortex (market data, signals, knowledge graph) and Synapse (portfolio, positions, trades, risk events). Two modes, one screen, everything the system knows rendered in braille and box-drawing characters.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Cortex DB     │     │   Synapse DB    │
│  (read-only)    │     │  (read-only)    │
│                 │     │                 │
│  prices         │     │  portfolio      │
│  news           │     │  positions      │
│  signals        │     │  trades         │
│  graph          │     │  signal_log     │
│  commands       │     │  risk_events    │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │
              ┌──────▼──────┐
              │    OPTIC    │
              │   ratatui   │
              │             │
              │  Market  │  │
              │  Trading │  │
              └─────────────┘
```

Cortex DB is always required. Synapse DB is optional -- if not provided, Optic runs in market-only mode with no trading panels or portfolio bar.

## Views

### Market Mode (`1`)

```
┌──────────────┬──────────────────┐
│  Prices      │  Signals         │
├──────────────┤                  │
│  Chart (24h) ├──────────────────┤
├──────────────┤  Knowledge Graph │
│  News Feed   │                  │
├──────────────┴──────────────────┤
│ [Portfolio Bar]                  │
├─────────────────────────────────┤
│ [Status]                         │
└─────────────────────────────────┘
```

Prices with computed 24h/7d change from stored snapshots. Braille sparkline charts, cycling through tracked tokens. News feed with memory linkage indicators. Signals grouped by token and timeframe. Knowledge graph edges sorted by recency and weight.

### Trading Mode (`2`)

```
┌───────────────┬─────────────────┐
│  Positions    │  Recent Trades  │
├───────────────┼─────────────────┤
│  Signal Log   │  Risk Events    │
├───────────────┴─────────────────┤
│ [Portfolio Bar]                  │
├─────────────────────────────────┤
│ [Status]                         │
└─────────────────────────────────┘
```

Open positions with entry/current price, unrealized P&L, stop loss, take profit. Trade audit log. Signal processing log showing which cortex signals were acted on vs skipped. Risk events color-coded by severity.

### Portfolio Bar

Always visible when synapse is connected. Shows NAV, cash, drawdown %, return vs high-water mark, halted status. Color-coded: green when healthy, yellow at 2% drawdown, red at 5%+.

## Keybindings

| Key | Action |
|-----|--------|
| `q` | Quit |
| `r` | Force refresh |
| `Tab` | Cycle focused panel |
| `j`/`k` | Scroll up/down in focused panel |
| `Enter` | Detail popup (news, signals) |
| `c` | Cycle chart token (market mode) |
| `a` | Queue analysis command (market mode) |
| `o` | Open URL in browser (news detail popup) |
| `1` | Switch to Market mode |
| `2` | Switch to Trading mode |

## Usage

```bash
# Market mode only (default)
just optic

# Both modes -- cortex + synapse
just optic ./data/cortex.db ./data/synapse.db

# Direct invocation
cd apps/optic && cargo run -- /path/to/cortex.db --synapse /path/to/synapse.db

# Build release binary
just optic-build
```

Environment variable fallbacks: `DATABASE_URL` for cortex, `SYNAPSE_DATABASE_URL` for synapse.

Auto-refreshes every 5 seconds. Both databases opened read-only with WAL mode.

---

> *Green text on black glass. Everything the system knows, one refresh away.*
