/**
 * Factory functions for Synapse test data.
 * Use the spread pattern: createTestX({ field: override })
 */

import type { Position, Trade, PortfolioState, SignalLog, RiskEvent } from "../db/schema.js";
import type { CortexSignal } from "../cortex/types.js";
import type { ExecutionResult } from "../types.js";
import type { Env } from "../env.js";

// ── Positions ──────────────────────────────────────────────────────

export function createTestPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: "pos-test-1",
    token_id: "bitcoin",
    token_symbol: "BTC",
    direction: "long",
    quantity: 0.1,
    entry_price_usd: 50000,
    current_price_usd: 50000,
    size_usd: 5000,
    unrealized_pnl_usd: 0,
    realized_pnl_usd: 0,
    stop_loss_price: 46000,
    take_profit_price: 60000,
    signal_id: "sig-test-1",
    opened_at: new Date().toISOString(),
    closed_at: null,
    ...overrides,
  };
}

// ── Trades ─────────────────────────────────────────────────────────

export function createTestTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "trade-test-1",
    position_id: "pos-test-1",
    signal_id: "sig-test-1",
    token_id: "bitcoin",
    direction: "buy",
    quantity: 0.1,
    price_usd: 50000,
    size_usd: 5000,
    gas_usd: 0.5,
    slippage_bps: 30,
    executed_at: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

// ── Cortex Signals ─────────────────────────────────────────────────

export function createTestSignal(overrides: Partial<CortexSignal> = {}): CortexSignal {
  return {
    id: "sig-test-1",
    token_id: "bitcoin",
    signal_type: "buy",
    confidence: 0.7,
    reasoning: "test reasoning",
    key_factors: null,
    memory_ids: null,
    timeframe: "short",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Portfolio State ────────────────────────────────────────────────

export function createTestPortfolioState(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    id: 1,
    cash_usd: 5000,
    total_value_usd: 10000,
    high_water_mark_usd: 10000,
    drawdown_pct: 0,
    halted: 0,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Execution Results ──────────────────────────────────────────────

export function createTestExecutionResult(
  overrides: Partial<ExecutionResult> = {},
): ExecutionResult {
  return {
    price_usd: 50000,
    quantity: 0.1,
    size_usd: 5000,
    gas_usd: 0.5,
    slippage_bps: 30,
    ...overrides,
  };
}

// ── Signal Log ─────────────────────────────────────────────────────

export function createTestSignalLog(overrides: Partial<SignalLog> = {}): SignalLog {
  return {
    id: "slog-test-1",
    cortex_signal_id: "sig-test-1",
    token_id: "bitcoin",
    signal_type: "buy",
    confidence: 0.7,
    timeframe: "short",
    action: "opened_position",
    skip_reason: null,
    processed_at: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

// ── Risk Events ────────────────────────────────────────────────────

export function createTestRiskEvent(overrides: Partial<RiskEvent> = {}): RiskEvent {
  return {
    id: "risk-test-1",
    event_type: "stop_loss",
    details: "Price dropped below stop-loss",
    position_id: "pos-test-1",
    created_at: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

// ── Env ────────────────────────────────────────────────────────────

export function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    CORTEX_DATABASE_URL: ":memory:",
    DATABASE_URL: ":memory:",
    INITIAL_BALANCE_USD: 10000,
    POLL_INTERVAL: 60,
    RISK_CHECK_INTERVAL: 30,
    MIN_CONFIDENCE_SHORT: 0.4,
    MIN_CONFIDENCE_LONG: 0.6,
    MIN_TRADE_USD: 50,
    SIMULATED_GAS_USD: 0.5,
    MAX_GAS_PCT: 2,
    MAX_POSITION_PCT: 25,
    MAX_PORTFOLIO_DRAWDOWN_PCT: 15,
    STOP_LOSS_PCT: 8,
    TAKE_PROFIT_PCT: 20,
    MAX_OPEN_POSITIONS: 8,
    SLIPPAGE_BPS: 30,
    ...overrides,
  };
}
