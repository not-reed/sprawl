import type { CortexSignal } from '../cortex/types.js'
import type { Env } from '../env.js'

export type FilterResult =
  | { pass: true }
  | { pass: false; reason: string }

export interface FilterConfig {
  minConfidenceShort: number
  minConfidenceLong: number
}

export function configFromEnv(env: Env): FilterConfig {
  return {
    minConfidenceShort: env.MIN_CONFIDENCE_SHORT,
    minConfidenceLong: env.MIN_CONFIDENCE_LONG,
  }
}

/**
 * Determine whether a cortex signal should trigger a trade.
 *
 * @param signal - The cortex signal to evaluate
 * @param config - Confidence thresholds
 * @param hasPosition - Whether we already hold this token
 * @param now - Current time (for staleness check)
 */
export function filterSignal(
  signal: CortexSignal,
  config: FilterConfig,
  hasPosition: boolean,
  now: Date = new Date(),
): FilterResult {
  const type = signal.signal_type.toLowerCase()
  const timeframe = signal.timeframe?.toLowerCase() ?? 'short'

  // Hold signals: always skip
  if (type === 'hold') {
    return { pass: false, reason: 'hold_signal' }
  }

  // Sell signal for token we don't hold: skip (no shorting)
  if (type === 'sell' && !hasPosition) {
    return { pass: false, reason: 'sell_no_position' }
  }

  // Staleness check
  const signalAge = now.getTime() - new Date(signal.created_at).getTime()
  const maxAgeMs = timeframe === 'long' ? 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000
  if (signalAge > maxAgeMs) {
    return { pass: false, reason: 'stale' }
  }

  // Confidence thresholds
  if (type === 'sell' && hasPosition) {
    // Lower bar for exits
    if (signal.confidence < 0.3) {
      return { pass: false, reason: 'low_confidence' }
    }
    return { pass: true }
  }

  if (type === 'buy') {
    const minConfidence = timeframe === 'long' ? config.minConfidenceLong : config.minConfidenceShort
    if (signal.confidence < minConfidence) {
      return { pass: false, reason: 'low_confidence' }
    }
    return { pass: true }
  }

  return { pass: false, reason: `unknown_signal_type:${type}` }
}
