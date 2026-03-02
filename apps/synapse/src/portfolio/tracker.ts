import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import {
  getOpenPositions,
  updatePosition,
  getPortfolioState,
  updatePortfolioState,
  insertSnapshot,
  getLatestSnapshot,
} from '../db/queries.js'

type DB = Kysely<Database>

/**
 * Update all open positions with current prices and recompute P&L.
 */
export async function updatePositionPrices(
  db: DB,
  prices: Map<string, number>,
): Promise<void> {
  const positions = await getOpenPositions(db)

  for (const pos of positions) {
    const currentPrice = prices.get(pos.token_id)
    if (currentPrice === undefined) continue

    const unrealizedPnl = (currentPrice - pos.entry_price_usd) * pos.quantity
    await updatePosition(db, pos.id, {
      current_price_usd: currentPrice,
      unrealized_pnl_usd: unrealizedPnl,
    })
  }
}

/**
 * Recalculate portfolio NAV, drawdown, and HWM. Updates portfolio_state.
 */
export async function recalculatePortfolio(db: DB): Promise<void> {
  const state = await getPortfolioState(db)
  if (!state) return

  const positions = await getOpenPositions(db)
  const positionsValue = positions.reduce(
    (sum, p) => sum + p.current_price_usd * p.quantity,
    0,
  )

  const totalValue = state.cash_usd + positionsValue
  const hwm = Math.max(state.high_water_mark_usd, totalValue)
  const drawdownPct = hwm > 0 ? ((hwm - totalValue) / hwm) * 100 : 0

  await updatePortfolioState(db, {
    total_value_usd: totalValue,
    high_water_mark_usd: hwm,
    drawdown_pct: drawdownPct,
  })
}

/**
 * Take a periodic snapshot if enough time has elapsed (~15min).
 */
export async function maybeSnapshot(db: DB): Promise<boolean> {
  const latest = await getLatestSnapshot(db)
  if (latest) {
    const elapsed = Date.now() - new Date(latest.captured_at).getTime()
    if (elapsed < 15 * 60 * 1000) return false
  }

  const state = await getPortfolioState(db)
  if (!state) return false

  const positions = await getOpenPositions(db)
  const positionsValue = positions.reduce(
    (sum, p) => sum + p.current_price_usd * p.quantity,
    0,
  )

  await insertSnapshot(db, {
    cash_usd: state.cash_usd,
    positions_value_usd: positionsValue,
    total_value_usd: state.total_value_usd,
    drawdown_pct: state.drawdown_pct,
    open_position_count: positions.length,
  })

  return true
}
