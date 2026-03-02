import { describe, it, expect } from 'vitest'
import { computePositionSize, type SizeConfig } from '../engine/position-sizer.js'

const config: SizeConfig = {
  maxPositionPct: 25,
  minTradeUsd: 50,
  simulatedGasUsd: 0.50,
  maxGasPct: 2,
}

describe('computePositionSize', () => {
  it('computes size as confidence * maxPct of portfolio', () => {
    // 0.8 * (10000 * 25/100) = 0.8 * 2500 = 2000
    const result = computePositionSize(0.8, 10_000, 10_000, config)
    expect(result).toEqual({ viable: true, sizeUsd: 2000 })
  })

  it('rejects below minimum trade size', () => {
    // 0.1 * (500 * 25/100) = 0.1 * 125 = 12.50 < 50
    const result = computePositionSize(0.1, 500, 500, config)
    expect(result.viable).toBe(false)
    if (!result.viable) expect(result.reason).toContain('below_min_trade')
  })

  it('rejects when gas is too expensive relative to trade', () => {
    // 0.4 * (100 * 25/100) = 0.4 * 25 = 10. Gas = 0.50/10 = 5% > 2%
    const smallConfig = { ...config, minTradeUsd: 5 }
    const result = computePositionSize(0.4, 100, 100, smallConfig)
    expect(result.viable).toBe(false)
    if (!result.viable) expect(result.reason).toContain('gas_too_expensive')
  })

  it('rejects when exceeding available cash', () => {
    // 0.8 * (10000 * 25/100) = 2000, but only 500 cash
    const result = computePositionSize(0.8, 10_000, 500, config)
    expect(result.viable).toBe(false)
    if (!result.viable) expect(result.reason).toContain('exceeds_cash')
  })

  it('respects available cash exactly at boundary', () => {
    // 0.5 * (10000 * 25/100) = 1250, cash = 1250
    const result = computePositionSize(0.5, 10_000, 1250, config)
    expect(result).toEqual({ viable: true, sizeUsd: 1250 })
  })
})
