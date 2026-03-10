import { createDb } from "@repo/db";
import { env } from "./env.js";
import { getPortfolioState, getOpenPositions, getRecentRiskEvents } from "./db/queries.js";
import type { Database } from "./db/schema.js";

const { db } = createDb<Database>(env.DATABASE_URL);

// ── Portfolio Summary ───────────────────────────────────────────────────

const state = await getPortfolioState(db);
if (!state) {
  console.log("No portfolio state found. Has synapse been started?");
  process.exit(1);
}

const totalReturn =
  ((state.total_value_usd - env.INITIAL_BALANCE_USD) / env.INITIAL_BALANCE_USD) * 100;

console.log("\n=== Portfolio Summary ===");
console.log(`  NAV:        $${state.total_value_usd.toFixed(2)}`);
console.log(`  Cash:       $${state.cash_usd.toFixed(2)}`);
console.log(`  HWM:        $${state.high_water_mark_usd.toFixed(2)}`);
console.log(`  Drawdown:   ${state.drawdown_pct.toFixed(2)}%`);
console.log(`  Return:     ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`);
console.log(`  Halted:     ${state.halted ? "YES" : "no"}`);
console.log(`  Updated:    ${state.updated_at}`);

// ── Open Positions ──────────────────────────────────────────────────────

const positions = await getOpenPositions(db);

console.log(`\n=== Open Positions (${positions.length}) ===`);
if (positions.length > 0) {
  const header = ["Symbol", "Dir", "Entry", "Current", "Size", "uPnL", "PnL%"];
  const rows = positions.map((p) => {
    const pnlPct = (p.unrealized_pnl_usd / p.size_usd) * 100;
    return [
      p.token_symbol,
      p.direction,
      `$${p.entry_price_usd.toFixed(4)}`,
      `$${p.current_price_usd.toFixed(4)}`,
      `$${p.size_usd.toFixed(2)}`,
      `${p.unrealized_pnl_usd >= 0 ? "+" : ""}$${p.unrealized_pnl_usd.toFixed(2)}`,
      `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`,
    ];
  });

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log("  " + header.map((h, i) => h.padEnd(widths[i])).join("  "));
  console.log("  " + widths.map((w) => "─".repeat(w)).join("──"));
  for (const row of rows) {
    console.log("  " + row.map((c, i) => c.padEnd(widths[i])).join("  "));
  }
} else {
  console.log("  (none)");
}

// ── Recent Trades ───────────────────────────────────────────────────────

const trades = await db
  .selectFrom("trades")
  .innerJoin("positions", "positions.id", "trades.position_id")
  .select([
    "trades.direction",
    "positions.token_symbol",
    "trades.price_usd",
    "trades.size_usd",
    "trades.executed_at",
  ])
  .orderBy("trades.executed_at", "desc")
  .limit(10)
  .execute();

console.log(`\n=== Recent Trades (last ${trades.length}) ===`);
if (trades.length > 0) {
  for (const t of trades) {
    const dir = t.direction.toUpperCase().padEnd(4);
    const ts = t.executed_at.replace("T", " ").slice(0, 19);
    console.log(
      `  ${ts}  ${dir} ${t.token_symbol}  $${t.price_usd.toFixed(4)}  size $${t.size_usd.toFixed(2)}`,
    );
  }
} else {
  console.log("  (none)");
}

// ── Risk Events ─────────────────────────────────────────────────────────

const riskEvents = await getRecentRiskEvents(db, 5);

if (riskEvents.length > 0) {
  console.log(`\n=== Recent Risk Events (${riskEvents.length}) ===`);
  for (const e of riskEvents) {
    const ts = e.created_at.replace("T", " ").slice(0, 19);
    console.log(`  ${ts}  [${e.event_type}] ${e.details}`);
  }
}

console.log();
await db.destroy();
