import { Cron } from 'croner'
import { nanoid } from 'nanoid'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import type { CortexReader } from '../cortex/reader.js'
import type { Executor } from '../types.js'
import type { Env } from '../env.js'
import { filterSignal, configFromEnv } from './signal-filter.js'
import { computePositionSize, sizeConfigFromEnv } from './position-sizer.js'
import {
  checkPositionRisk,
  computeStopTakeProfit,
  checkPortfolioRisk,
  canOpenPosition,
  checkExposureLimit,
  riskConfigFromEnv,
} from './risk.js'
import { getAllPrices } from './pricing.js'
import {
  getPortfolioState,
  getOpenPositions,
  getOpenPositionByToken,
  insertPosition,
  updatePosition,
  updatePortfolioState,
  insertTrade,
  isSignalProcessed,
  logSignal,
  logRiskEvent,
} from '../db/queries.js'
import {
  updatePositionPrices,
  recalculatePortfolio,
  maybeSnapshot,
} from '../portfolio/tracker.js'

const jobs: Cron[] = []

export interface LoopContext {
  db: Kysely<Database>
  cortex: CortexReader
  executor: Executor
  env: Env
  log: (msg: string) => void
}

export function startLoop(ctx: LoopContext): void {
  const { env, log } = ctx

  // Signal poll
  const pollSeconds = Math.max(10, env.POLL_INTERVAL)
  const pollJob = new Cron(`*/${Math.max(1, Math.floor(pollSeconds / 60))} * * * *`, async () => {
    try {
      await pollSignals(ctx)
    } catch (err) {
      log(`Signal poll error: ${err}`)
    }
  })
  jobs.push(pollJob)

  // Risk check (more frequent — use seconds cron if <60s)
  const riskSeconds = Math.max(10, env.RISK_CHECK_INTERVAL)
  const riskCron = riskSeconds < 60
    ? `*/${riskSeconds} * * * * *`
    : `*/${Math.max(1, Math.floor(riskSeconds / 60))} * * * *`
  const riskJob = new Cron(riskCron, async () => {
    try {
      await runRiskCheck(ctx)
    } catch (err) {
      log(`Risk check error: ${err}`)
    }
  })
  jobs.push(riskJob)

  log(`Loop started: signal poll every ${pollSeconds}s, risk check every ${riskSeconds}s`)
}

export function stopLoop(): void {
  for (const job of jobs) {
    job.stop()
  }
  jobs.length = 0
}

// ── Signal Poll ─────────────────────────────────────────────────────────

export async function pollSignals(ctx: LoopContext): Promise<void> {
  const { db, cortex, env, log } = ctx

  const filterConfig = configFromEnv(env)
  const sizeConfig = sizeConfigFromEnv(env)
  const riskConfig = riskConfigFromEnv(env)

  const signals = await cortex.getLatestSignals()
  const tokens = await cortex.getActiveTokens()
  const tokenSymbols = new Map(tokens.map((t) => [t.id, t.symbol]))

  let processed = 0

  for (const signal of signals) {
    // Dedup check
    if (await isSignalProcessed(db, signal.id)) continue

    const hasPosition = !!(await getOpenPositionByToken(db, signal.token_id))
    const now = new Date()

    // Filter
    const filterResult = filterSignal(signal, filterConfig, hasPosition, now)
    if (!filterResult.pass) {
      await logSignal(db, {
        cortex_signal_id: signal.id,
        token_id: signal.token_id,
        signal_type: signal.signal_type,
        confidence: signal.confidence,
        timeframe: signal.timeframe,
        action: 'skipped',
        skip_reason: filterResult.reason,
      })
      processed++
      continue
    }

    const type = signal.signal_type.toLowerCase()

    if (type === 'buy') {
      await handleBuySignal(ctx, signal, tokenSymbols, sizeConfig, riskConfig)
    } else if (type === 'sell' && hasPosition) {
      await handleSellSignal(ctx, signal)
    }

    processed++
  }

  if (processed > 0) {
    log(`Processed ${processed} signals`)
  }
}

async function handleBuySignal(
  ctx: LoopContext,
  signal: import('../cortex/types.js').CortexSignal,
  tokenSymbols: Map<string, string>,
  sizeConfig: import('./position-sizer.js').SizeConfig,
  riskConfig: import('./risk.js').RiskConfig,
): Promise<void> {
  const { db, executor, log } = ctx

  const state = await getPortfolioState(db)
  if (!state) return

  const openPositions = await getOpenPositions(db)

  // Pre-trade risk checks
  const canOpen = canOpenPosition(state, openPositions.length, riskConfig)
  if (!canOpen.allowed) {
    await logSignal(db, {
      cortex_signal_id: signal.id,
      token_id: signal.token_id,
      signal_type: signal.signal_type,
      confidence: signal.confidence,
      timeframe: signal.timeframe,
      action: 'skipped',
      skip_reason: canOpen.reason,
    })
    return
  }

  // Position sizing
  const sizing = computePositionSize(
    signal.confidence,
    state.total_value_usd,
    state.cash_usd,
    sizeConfig,
  )
  if (!sizing.viable) {
    await logSignal(db, {
      cortex_signal_id: signal.id,
      token_id: signal.token_id,
      signal_type: signal.signal_type,
      confidence: signal.confidence,
      timeframe: signal.timeframe,
      action: 'skipped',
      skip_reason: sizing.reason,
    })
    return
  }

  // Exposure check
  const existingExposure = openPositions
    .filter((p) => p.token_id === signal.token_id)
    .reduce((sum, p) => sum + p.current_price_usd * p.quantity, 0)

  const exposureCheck = checkExposureLimit(
    sizing.sizeUsd,
    existingExposure,
    state.total_value_usd,
    riskConfig,
  )
  if (!exposureCheck.allowed) {
    await logSignal(db, {
      cortex_signal_id: signal.id,
      token_id: signal.token_id,
      signal_type: signal.signal_type,
      confidence: signal.confidence,
      timeframe: signal.timeframe,
      action: 'skipped',
      skip_reason: exposureCheck.reason,
    })
    await logRiskEvent(db, {
      event_type: 'exposure_limit',
      details: exposureCheck.reason,
    })
    return
  }

  // Execute paper trade
  const result = await executor.buy(signal.token_id, sizing.sizeUsd)

  // Compute stop/take-profit
  const { stopLossPrice, takeProfitPrice } = computeStopTakeProfit(
    result.price_usd,
    signal.timeframe,
    riskConfig,
  )

  // Create position
  const positionId = nanoid()
  await insertPosition(db, {
    id: positionId,
    token_id: signal.token_id,
    token_symbol: tokenSymbols.get(signal.token_id) ?? signal.token_id,
    direction: 'long',
    quantity: result.quantity,
    entry_price_usd: result.price_usd,
    current_price_usd: result.price_usd,
    size_usd: result.size_usd,
    unrealized_pnl_usd: 0,
    stop_loss_price: stopLossPrice,
    take_profit_price: takeProfitPrice,
    signal_id: signal.id,
    closed_at: null,
  })

  // Record trade
  await insertTrade(db, {
    position_id: positionId,
    signal_id: signal.id,
    token_id: signal.token_id,
    direction: 'buy',
    quantity: result.quantity,
    price_usd: result.price_usd,
    size_usd: result.size_usd,
    gas_usd: result.gas_usd,
    slippage_bps: result.slippage_bps,
  })

  // Update cash
  await updatePortfolioState(db, {
    cash_usd: state.cash_usd - result.size_usd,
  })

  await logSignal(db, {
    cortex_signal_id: signal.id,
    token_id: signal.token_id,
    signal_type: signal.signal_type,
    confidence: signal.confidence,
    timeframe: signal.timeframe,
    action: 'opened_position',
    skip_reason: null,
  })

  const symbol = tokenSymbols.get(signal.token_id) ?? signal.token_id
  log(`BUY ${symbol}: $${result.size_usd.toFixed(2)} @ $${result.price_usd.toFixed(2)} (conf: ${signal.confidence})`)
}

async function handleSellSignal(
  ctx: LoopContext,
  signal: import('../cortex/types.js').CortexSignal,
): Promise<void> {
  const { db, log } = ctx

  const position = await getOpenPositionByToken(db, signal.token_id)
  if (!position) return

  await closePosition(ctx, position, signal.id, 'sell_signal')

  await logSignal(db, {
    cortex_signal_id: signal.id,
    token_id: signal.token_id,
    signal_type: signal.signal_type,
    confidence: signal.confidence,
    timeframe: signal.timeframe,
    action: 'closed_position',
    skip_reason: null,
  })

  log(`SELL ${position.token_symbol}: closed position (signal)`)
}

// ── Risk Check ──────────────────────────────────────────────────────────

export async function runRiskCheck(ctx: LoopContext): Promise<void> {
  const { db, cortex, log } = ctx
  const riskConfig = riskConfigFromEnv(ctx.env)

  // Fetch current prices
  const prices = await getAllPrices(cortex)
  if (prices.size === 0) return

  // Update position prices
  await updatePositionPrices(db, prices)

  // Check per-position stop-loss / take-profit
  const positions = await getOpenPositions(db)
  for (const pos of positions) {
    const currentPrice = prices.get(pos.token_id)
    if (currentPrice === undefined) continue

    const riskResult = checkPositionRisk(pos, currentPrice)
    if (riskResult.action === 'close') {
      await closePosition(ctx, pos, pos.signal_id, riskResult.reason)
      await logRiskEvent(db, {
        event_type: riskResult.reason,
        details: `${pos.token_symbol} @ $${currentPrice.toFixed(2)} (entry: $${pos.entry_price_usd.toFixed(2)})`,
        position_id: pos.id,
      })
      log(`RISK ${riskResult.reason.toUpperCase()}: ${pos.token_symbol} @ $${currentPrice.toFixed(2)}`)
    }
  }

  // Recalculate portfolio
  await recalculatePortfolio(db)

  // Portfolio-level drawdown check
  const state = await getPortfolioState(db)
  if (state) {
    const portfolioRisk = checkPortfolioRisk(
      state.total_value_usd,
      state.high_water_mark_usd,
      riskConfig,
    )

    if (!portfolioRisk.safe && !state.halted) {
      log(`DRAWDOWN HALT: ${state.drawdown_pct.toFixed(1)}% — closing all positions`)

      // Close all remaining positions
      const remaining = await getOpenPositions(db)
      for (const pos of remaining) {
        await closePosition(ctx, pos, pos.signal_id, 'drawdown_halt')
      }

      await updatePortfolioState(db, { halted: 1 })
      await logRiskEvent(db, {
        event_type: 'drawdown_halt',
        details: `Drawdown ${state.drawdown_pct.toFixed(1)}% >= ${riskConfig.maxDrawdownPct}%. All positions closed.`,
      })
    }
  }

  // Periodic snapshot
  await maybeSnapshot(db)
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function closePosition(
  ctx: LoopContext,
  position: import('../db/schema.js').Position,
  signalId: string,
  _reason: string,
): Promise<void> {
  const { db, executor } = ctx

  const result = await executor.sell(position.token_id, position.quantity)
  const realizedPnl = result.size_usd - position.size_usd

  // Update position
  await updatePosition(db, position.id, {
    current_price_usd: result.price_usd,
    unrealized_pnl_usd: 0,
    realized_pnl_usd: realizedPnl,
    closed_at: new Date().toISOString(),
  })

  // Record trade
  await insertTrade(db, {
    position_id: position.id,
    signal_id: signalId,
    token_id: position.token_id,
    direction: 'sell',
    quantity: position.quantity,
    price_usd: result.price_usd,
    size_usd: result.size_usd,
    gas_usd: result.gas_usd,
    slippage_bps: result.slippage_bps,
  })

  // Return cash
  const state = await getPortfolioState(db)
  if (state) {
    await updatePortfolioState(db, {
      cash_usd: state.cash_usd + result.size_usd,
    })
  }
}
