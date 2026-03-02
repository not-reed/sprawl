import { describe, it, expect } from 'vitest'
import {
  checkPositionRisk,
  computeStopTakeProfit,
  checkPortfolioRisk,
  canOpenPosition,
  checkExposureLimit,
  type RiskConfig,
} from '../engine/risk.js'
import type { Position, PortfolioState } from '../db/schema.js'

const config: RiskConfig = {
  stopLossPct: 8,
  takeProfitPct: 20,
  maxPositionPct: 25,
  maxOpenPositions: 8,
  maxDrawdownPct: 15,
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    token_id: 'bitcoin',
    token_symbol: 'BTC',
    direction: 'long',
    quantity: 0.1,
    entry_price_usd: 50000,
    current_price_usd: 50000,
    size_usd: 5000,
    unrealized_pnl_usd: 0,
    realized_pnl_usd: 0,
    stop_loss_price: 46000,
    take_profit_price: 60000,
    signal_id: 'sig-1',
    opened_at: new Date().toISOString(),
    closed_at: null,
    ...overrides,
  }
}

function makePortfolioState(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    id: 1,
    cash_usd: 5000,
    total_value_usd: 10000,
    high_water_mark_usd: 10000,
    drawdown_pct: 0,
    halted: 0,
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('checkPositionRisk', () => {
  it('holds when price is between stop and take-profit', () => {
    const result = checkPositionRisk(makePosition(), 50000)
    expect(result).toEqual({ action: 'hold' })
  })

  it('triggers stop-loss when price drops below stop', () => {
    const result = checkPositionRisk(makePosition({ stop_loss_price: 46000 }), 45000)
    expect(result).toEqual({ action: 'close', reason: 'stop_loss' })
  })

  it('triggers take-profit when price rises above target', () => {
    const result = checkPositionRisk(makePosition({ take_profit_price: 60000 }), 61000)
    expect(result).toEqual({ action: 'close', reason: 'take_profit' })
  })

  it('triggers at exact stop-loss price', () => {
    const result = checkPositionRisk(makePosition({ stop_loss_price: 46000 }), 46000)
    expect(result).toEqual({ action: 'close', reason: 'stop_loss' })
  })
})

describe('computeStopTakeProfit', () => {
  it('uses 5% stop for short-term signals', () => {
    const { stopLossPrice, takeProfitPrice } = computeStopTakeProfit(100, 'short', config)
    expect(stopLossPrice).toBe(95)
    expect(takeProfitPrice).toBe(120)
  })

  it('uses configured stop for long-term signals (8%)', () => {
    const { stopLossPrice, takeProfitPrice } = computeStopTakeProfit(100, 'long', config)
    expect(stopLossPrice).toBe(92)
    expect(takeProfitPrice).toBe(120)
  })
})

describe('checkPortfolioRisk', () => {
  it('safe when no drawdown', () => {
    expect(checkPortfolioRisk(10000, 10000, config)).toEqual({ safe: true })
  })

  it('safe when drawdown below threshold', () => {
    // 10% drawdown, threshold 15%
    expect(checkPortfolioRisk(9000, 10000, config)).toEqual({ safe: true })
  })

  it('triggers halt at max drawdown', () => {
    // 15% drawdown
    expect(checkPortfolioRisk(8500, 10000, config)).toEqual({ safe: false, reason: 'drawdown_halt' })
  })

  it('triggers halt beyond max drawdown', () => {
    expect(checkPortfolioRisk(8000, 10000, config)).toEqual({ safe: false, reason: 'drawdown_halt' })
  })
})

describe('canOpenPosition', () => {
  it('allows when healthy', () => {
    expect(canOpenPosition(makePortfolioState(), 3, config)).toEqual({ allowed: true })
  })

  it('blocks when halted', () => {
    const result = canOpenPosition(makePortfolioState({ halted: 1 }), 0, config)
    expect(result.allowed).toBe(false)
  })

  it('blocks at max open positions', () => {
    const result = canOpenPosition(makePortfolioState(), 8, config)
    expect(result.allowed).toBe(false)
  })

  it('blocks at pre-drawdown caution (80% of 15% = 12%)', () => {
    const result = canOpenPosition(makePortfolioState({ drawdown_pct: 12.5 }), 3, config)
    expect(result.allowed).toBe(false)
  })
})

describe('checkExposureLimit', () => {
  it('allows within limit', () => {
    // 1000 + 0 = 10% of 10000 portfolio
    expect(checkExposureLimit(1000, 0, 10000, config)).toEqual({ allowed: true })
  })

  it('blocks when exceeding max exposure', () => {
    // 2000 + 1000 = 3000 = 30% of 10000 > 25%
    const result = checkExposureLimit(2000, 1000, 10000, config)
    expect(result.allowed).toBe(false)
  })
})
