import type { Env } from '../env.js'

export interface SizeConfig {
  maxPositionPct: number
  minTradeUsd: number
  simulatedGasUsd: number
  maxGasPct: number
}

export function sizeConfigFromEnv(env: Env): SizeConfig {
  return {
    maxPositionPct: env.MAX_POSITION_PCT,
    minTradeUsd: env.MIN_TRADE_USD,
    simulatedGasUsd: env.SIMULATED_GAS_USD,
    maxGasPct: env.MAX_GAS_PCT,
  }
}

export type SizeResult =
  | { viable: true; sizeUsd: number }
  | { viable: false; reason: string }

/**
 * Compute position size from confidence and portfolio value.
 *
 * size_usd = confidence * (total_value * max_position_pct / 100)
 *
 * Rejects if below min trade size, gas is too expensive, or exceeds available cash.
 */
export function computePositionSize(
  confidence: number,
  totalPortfolioValueUsd: number,
  availableCashUsd: number,
  config: SizeConfig,
): SizeResult {
  const sizeUsd = confidence * (totalPortfolioValueUsd * config.maxPositionPct / 100)

  if (sizeUsd < config.minTradeUsd) {
    return { viable: false, reason: `below_min_trade:${sizeUsd.toFixed(2)}<${config.minTradeUsd}` }
  }

  const gasPct = (config.simulatedGasUsd / sizeUsd) * 100
  if (gasPct > config.maxGasPct) {
    return { viable: false, reason: `gas_too_expensive:${gasPct.toFixed(1)}%>${config.maxGasPct}%` }
  }

  if (sizeUsd > availableCashUsd) {
    return { viable: false, reason: `exceeds_cash:${sizeUsd.toFixed(2)}>${availableCashUsd.toFixed(2)}` }
  }

  return { viable: true, sizeUsd }
}
