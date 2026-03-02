import type { Position, PortfolioState } from '../db/schema.js'
import type { Env } from '../env.js'

export interface RiskConfig {
  stopLossPct: number
  takeProfitPct: number
  maxPositionPct: number
  maxOpenPositions: number
  maxDrawdownPct: number
}

export function riskConfigFromEnv(env: Env): RiskConfig {
  return {
    stopLossPct: env.STOP_LOSS_PCT,
    takeProfitPct: env.TAKE_PROFIT_PCT,
    maxPositionPct: env.MAX_POSITION_PCT,
    maxOpenPositions: env.MAX_OPEN_POSITIONS,
    maxDrawdownPct: env.MAX_PORTFOLIO_DRAWDOWN_PCT,
  }
}

export type PositionRiskResult =
  | { action: 'hold' }
  | { action: 'close'; reason: 'stop_loss' | 'take_profit' }

/**
 * Check if a position should be closed based on stop-loss or take-profit.
 */
export function checkPositionRisk(position: Position, currentPrice: number): PositionRiskResult {
  if (currentPrice <= position.stop_loss_price) {
    return { action: 'close', reason: 'stop_loss' }
  }
  if (currentPrice >= position.take_profit_price) {
    return { action: 'close', reason: 'take_profit' }
  }
  return { action: 'hold' }
}

/**
 * Compute stop-loss and take-profit prices for a new position.
 * Short-term signals get tighter stops (5%) vs long-term (default STOP_LOSS_PCT).
 */
export function computeStopTakeProfit(
  entryPrice: number,
  timeframe: string,
  config: RiskConfig,
): { stopLossPrice: number; takeProfitPrice: number } {
  const stopPct = timeframe === 'short' ? 5 : config.stopLossPct
  const stopLossPrice = entryPrice * (1 - stopPct / 100)
  const takeProfitPrice = entryPrice * (1 + config.takeProfitPct / 100)
  return { stopLossPrice, takeProfitPrice }
}

export type PortfolioRiskResult =
  | { safe: true }
  | { safe: false; reason: 'drawdown_halt' }

/**
 * Check portfolio-level drawdown against the halt threshold.
 */
export function checkPortfolioRisk(
  totalValue: number,
  highWaterMark: number,
  config: RiskConfig,
): PortfolioRiskResult {
  const drawdownPct = ((highWaterMark - totalValue) / highWaterMark) * 100
  if (drawdownPct >= config.maxDrawdownPct) {
    return { safe: false, reason: 'drawdown_halt' }
  }
  return { safe: true }
}

/**
 * Check if we can open a new position (pre-trade risk gate).
 */
export function canOpenPosition(
  state: PortfolioState,
  openPositionCount: number,
  config: RiskConfig,
): { allowed: true } | { allowed: false; reason: string } {
  if (state.halted) {
    return { allowed: false, reason: 'portfolio_halted' }
  }

  if (openPositionCount >= config.maxOpenPositions) {
    return { allowed: false, reason: `max_positions:${openPositionCount}>=${config.maxOpenPositions}` }
  }

  // Pre-drawdown caution: stop opening at 80% of max drawdown
  const cautionThreshold = config.maxDrawdownPct * 0.8
  if (state.drawdown_pct >= cautionThreshold) {
    return { allowed: false, reason: `pre_drawdown_caution:${state.drawdown_pct.toFixed(1)}%>=${cautionThreshold}%` }
  }

  return { allowed: true }
}

/**
 * Check single-token exposure limit.
 */
export function checkExposureLimit(
  positionSizeUsd: number,
  existingExposureUsd: number,
  totalPortfolioValue: number,
  config: RiskConfig,
): { allowed: true } | { allowed: false; reason: string } {
  const totalExposure = positionSizeUsd + existingExposureUsd
  const exposurePct = (totalExposure / totalPortfolioValue) * 100
  if (exposurePct > config.maxPositionPct) {
    return { allowed: false, reason: `exposure_limit:${exposurePct.toFixed(1)}%>${config.maxPositionPct}%` }
  }
  return { allowed: true }
}
