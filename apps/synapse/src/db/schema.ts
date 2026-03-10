import type { Generated, Insertable, Selectable } from "kysely";

export interface Database {
  portfolio_state: PortfolioStateTable;
  positions: PositionTable;
  trades: TradeTable;
  snapshots: SnapshotTable;
  signal_log: SignalLogTable;
  risk_events: RiskEventTable;
}

// ── Portfolio State (singleton row) ─────────────────────────────────────

export interface PortfolioStateTable {
  id: Generated<number>; // always 1
  cash_usd: number;
  total_value_usd: number;
  high_water_mark_usd: number;
  drawdown_pct: number;
  halted: Generated<number>; // 0 or 1
  updated_at: Generated<string>;
}

export type PortfolioState = Selectable<PortfolioStateTable>;

// ── Positions ───────────────────────────────────────────────────────────

export interface PositionTable {
  id: string;
  token_id: string;
  token_symbol: string;
  direction: string; // "long"
  quantity: number;
  entry_price_usd: number;
  current_price_usd: number;
  size_usd: number; // entry cost
  unrealized_pnl_usd: number;
  realized_pnl_usd: Generated<number>;
  stop_loss_price: number;
  take_profit_price: number;
  signal_id: string; // originating cortex signal
  opened_at: Generated<string>;
  closed_at: string | null;
}

export type Position = Selectable<PositionTable>;
export type NewPosition = Insertable<PositionTable>;

// ── Trades (immutable audit log) ────────────────────────────────────────

export interface TradeTable {
  id: string;
  position_id: string;
  signal_id: string;
  token_id: string;
  direction: string; // "buy" | "sell"
  quantity: number;
  price_usd: number;
  size_usd: number;
  gas_usd: number;
  slippage_bps: number;
  executed_at: Generated<string>;
}

export type Trade = Selectable<TradeTable>;
export type NewTrade = Insertable<TradeTable>;

// ── Snapshots (periodic NAV) ────────────────────────────────────────────

export interface SnapshotTable {
  id: string;
  cash_usd: number;
  positions_value_usd: number;
  total_value_usd: number;
  drawdown_pct: number;
  open_position_count: number;
  captured_at: Generated<string>;
}

export type Snapshot = Selectable<SnapshotTable>;
export type NewSnapshot = Insertable<SnapshotTable>;

// ── Signal Log ──────────────────────────────────────────────────────────

export interface SignalLogTable {
  id: string;
  cortex_signal_id: string; // cortex signals.id
  token_id: string;
  signal_type: string;
  confidence: number;
  timeframe: string;
  action: string; // "opened_position" | "closed_position" | "skipped"
  skip_reason: string | null;
  processed_at: Generated<string>;
}

export type SignalLog = Selectable<SignalLogTable>;
export type NewSignalLog = Insertable<SignalLogTable>;

// ── Risk Events ─────────────────────────────────────────────────────────

export interface RiskEventTable {
  id: string;
  event_type: string; // "stop_loss" | "take_profit" | "drawdown_halt" | "exposure_limit"
  details: string;
  position_id: string | null;
  created_at: Generated<string>;
}

export type RiskEvent = Selectable<RiskEventTable>;
export type NewRiskEvent = Insertable<RiskEventTable>;
