import { describe, it, expect } from 'vitest'
import { filterSignal, type FilterConfig } from '../engine/signal-filter.js'
import type { CortexSignal } from '../cortex/types.js'

const config: FilterConfig = {
  minConfidenceShort: 0.4,
  minConfidenceLong: 0.6,
}

function makeSignal(overrides: Partial<CortexSignal> = {}): CortexSignal {
  return {
    id: 'sig-1',
    token_id: 'bitcoin',
    signal_type: 'buy',
    confidence: 0.7,
    reasoning: 'test',
    key_factors: null,
    memory_ids: null,
    timeframe: 'short',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('filterSignal', () => {
  it('passes a buy signal with sufficient confidence', () => {
    const result = filterSignal(makeSignal({ confidence: 0.5 }), config, false)
    expect(result.pass).toBe(true)
  })

  it('rejects hold signals', () => {
    const result = filterSignal(makeSignal({ signal_type: 'hold' }), config, false)
    expect(result).toEqual({ pass: false, reason: 'hold_signal' })
  })

  it('rejects sell without position (no shorting)', () => {
    const result = filterSignal(makeSignal({ signal_type: 'sell' }), config, false)
    expect(result).toEqual({ pass: false, reason: 'sell_no_position' })
  })

  it('passes sell with position and low confidence (0.3)', () => {
    const result = filterSignal(
      makeSignal({ signal_type: 'sell', confidence: 0.3 }),
      config,
      true,
    )
    expect(result.pass).toBe(true)
  })

  it('rejects sell with position below 0.3 confidence', () => {
    const result = filterSignal(
      makeSignal({ signal_type: 'sell', confidence: 0.2 }),
      config,
      true,
    )
    expect(result).toEqual({ pass: false, reason: 'low_confidence' })
  })

  it('rejects short-term buy below 0.4 confidence', () => {
    const result = filterSignal(
      makeSignal({ confidence: 0.3, timeframe: 'short' }),
      config,
      false,
    )
    expect(result).toEqual({ pass: false, reason: 'low_confidence' })
  })

  it('rejects long-term buy below 0.6 confidence', () => {
    const result = filterSignal(
      makeSignal({ confidence: 0.5, timeframe: 'long' }),
      config,
      false,
    )
    expect(result).toEqual({ pass: false, reason: 'low_confidence' })
  })

  it('passes long-term buy at 0.6 confidence', () => {
    const result = filterSignal(
      makeSignal({ confidence: 0.6, timeframe: 'long' }),
      config,
      false,
    )
    expect(result.pass).toBe(true)
  })

  it('rejects stale short-term signals (>2h)', () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    const result = filterSignal(
      makeSignal({ created_at: staleTime, timeframe: 'short' }),
      config,
      false,
    )
    expect(result).toEqual({ pass: false, reason: 'stale' })
  })

  it('rejects stale long-term signals (>24h)', () => {
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    const result = filterSignal(
      makeSignal({ created_at: staleTime, timeframe: 'long' }),
      config,
      false,
    )
    expect(result).toEqual({ pass: false, reason: 'stale' })
  })

  it('accepts fresh long-term signal within 24h', () => {
    const freshTime = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
    const result = filterSignal(
      makeSignal({ created_at: freshTime, timeframe: 'long', confidence: 0.7 }),
      config,
      false,
    )
    expect(result.pass).toBe(true)
  })
})
