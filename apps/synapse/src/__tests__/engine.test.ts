import { describe, it, expect, beforeEach } from 'vitest'
import { Kysely } from 'kysely'
import { createDb } from '@repo/db'
import { runMigrations } from '@repo/db/migrate'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Database } from '../db/schema.js'
import type { CortexDatabase } from '../cortex/types.js'
import {
  initPortfolioState,
  getPortfolioState,
  getOpenPositions,
  isSignalProcessed,
} from '../db/queries.js'
import { pollSignals, runRiskCheck } from '../engine/loop.js'
import type { Executor, ExecutionResult } from '../types.js'
import type { Env } from '../env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Minimal cortex schema migration for test fixture
async function migrateCortexFixture(db: Kysely<CortexDatabase>) {
  const { sql } = await import('kysely')

  await db.schema
    .createTable('tracked_tokens')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('symbol', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('added_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  await db.schema
    .createTable('price_snapshots')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('token_id', 'text', (col) => col.notNull())
    .addColumn('price_usd', 'real', (col) => col.notNull())
    .addColumn('market_cap', 'real')
    .addColumn('volume_24h', 'real')
    .addColumn('change_24h', 'real')
    .addColumn('change_7d', 'real')
    .addColumn('captured_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()

  await db.schema
    .createTable('signals')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('token_id', 'text', (col) => col.notNull())
    .addColumn('signal_type', 'text', (col) => col.notNull())
    .addColumn('confidence', 'real', (col) => col.notNull())
    .addColumn('reasoning', 'text', (col) => col.notNull())
    .addColumn('key_factors', 'text')
    .addColumn('memory_ids', 'text')
    .addColumn('timeframe', 'text', (col) => col.notNull().defaultTo('short'))
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute()
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CORTEX_DATABASE_URL: ':memory:',
    DATABASE_URL: ':memory:',
    INITIAL_BALANCE_USD: 10000,
    POLL_INTERVAL: 60,
    RISK_CHECK_INTERVAL: 30,
    MIN_CONFIDENCE_SHORT: 0.4,
    MIN_CONFIDENCE_LONG: 0.6,
    MIN_TRADE_USD: 50,
    SIMULATED_GAS_USD: 0.50,
    MAX_GAS_PCT: 2,
    MAX_POSITION_PCT: 25,
    MAX_PORTFOLIO_DRAWDOWN_PCT: 15,
    STOP_LOSS_PCT: 8,
    TAKE_PROFIT_PCT: 20,
    MAX_OPEN_POSITIONS: 8,
    SLIPPAGE_BPS: 30,
    ...overrides,
  }
}

/** Mock executor that uses a fixed price map. */
class MockExecutor implements Executor {
  prices: Map<string, number>

  constructor(prices: Map<string, number>) {
    this.prices = prices
  }

  async buy(tokenId: string, amountUsd: number): Promise<ExecutionResult> {
    const price = this.prices.get(tokenId) ?? 1000
    const quantity = (amountUsd - 0.50) / price
    return {
      price_usd: price,
      quantity,
      size_usd: amountUsd,
      gas_usd: 0.50,
      slippage_bps: 30,
    }
  }

  async sell(tokenId: string, quantity: number): Promise<ExecutionResult> {
    const price = this.prices.get(tokenId) ?? 1000
    const sizeUsd = quantity * price - 0.50
    return {
      price_usd: price,
      quantity,
      size_usd: sizeUsd,
      gas_usd: 0.50,
      slippage_bps: 30,
    }
  }
}

describe('engine integration', () => {
  let synapseDb: Kysely<Database>
  let cortexDb: Kysely<CortexDatabase>
  let executor: MockExecutor
  let env: Env
  const logs: string[] = []

  beforeEach(async () => {
    logs.length = 0

    // Create in-memory synapse DB
    const synapse = createDb<Database>(':memory:')
    synapseDb = synapse.db
    await runMigrations(
      synapseDb as any,
      join(__dirname, '..', 'db', 'migrations'),
    )
    await initPortfolioState(synapseDb, 10000)

    // Create in-memory cortex DB
    const cortex = createDb<CortexDatabase>(':memory:')
    cortexDb = cortex.db
    await migrateCortexFixture(cortexDb)

    // Seed cortex data
    await cortexDb
      .insertInto('tracked_tokens')
      .values({ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' })
      .execute()

    await cortexDb
      .insertInto('price_snapshots')
      .values({
        id: 'ps-1',
        token_id: 'bitcoin',
        price_usd: 50000,
        market_cap: null,
        volume_24h: null,
        change_24h: null,
        change_7d: null,
      })
      .execute()

    executor = new MockExecutor(new Map([['bitcoin', 50000]]))
    env = makeEnv()
  })

  function makeCtx() {
    // Create a mock CortexReader that delegates to our in-memory cortexDb
    const cortexReader = {
      db: cortexDb,
      async getLatestSignals() {
        const rows = await cortexDb
          .selectFrom('signals as s')
          .selectAll()
          .where(
            's.created_at',
            '=',
            cortexDb
              .selectFrom('signals as s2')
              .select(({ fn }) => fn.max('s2.created_at').as('max_at'))
              .whereRef('s2.token_id', '=', 's.token_id'),
          )
          .execute()
        return rows
      },
      async getLatestPrices() {
        const rows = await cortexDb
          .selectFrom('price_snapshots as ps')
          .selectAll()
          .where(
            'ps.captured_at',
            '=',
            cortexDb
              .selectFrom('price_snapshots as ps2')
              .select(({ fn }) => fn.max('ps2.captured_at').as('max_at'))
              .whereRef('ps2.token_id', '=', 'ps.token_id'),
          )
          .execute()
        return rows
      },
      async getTokenPrice(tokenId: string) {
        return cortexDb
          .selectFrom('price_snapshots')
          .selectAll()
          .where('token_id', '=', tokenId)
          .orderBy('captured_at', 'desc')
          .limit(1)
          .executeTakeFirst()
      },
      async getActiveTokens() {
        return cortexDb
          .selectFrom('tracked_tokens')
          .selectAll()
          .where('active', '=', 1)
          .execute()
      },
      async destroy() {},
    }

    return {
      db: synapseDb,
      cortex: cortexReader as any,
      executor,
      env,
      log: (msg: string) => logs.push(msg),
    }
  }

  it('opens a position on a buy signal', async () => {
    // Insert a buy signal into cortex
    await cortexDb.insertInto('signals').values({
      id: 'sig-buy-1',
      token_id: 'bitcoin',
      signal_type: 'buy',
      confidence: 0.7,
      reasoning: 'bullish',
      timeframe: 'short',
    }).execute()

    await pollSignals(makeCtx())

    // Should have opened a position
    const positions = await getOpenPositions(synapseDb)
    expect(positions).toHaveLength(1)
    expect(positions[0].token_id).toBe('bitcoin')
    expect(positions[0].direction).toBe('long')

    // Signal should be logged
    expect(await isSignalProcessed(synapseDb, 'sig-buy-1')).toBe(true)

    // Cash should have decreased
    const state = await getPortfolioState(synapseDb)
    expect(state!.cash_usd).toBeLessThan(10000)
  })

  it('skips already-processed signals', async () => {
    await cortexDb.insertInto('signals').values({
      id: 'sig-dup',
      token_id: 'bitcoin',
      signal_type: 'buy',
      confidence: 0.7,
      reasoning: 'bullish',
      timeframe: 'short',
    }).execute()

    const ctx = makeCtx()
    await pollSignals(ctx)
    await pollSignals(ctx)

    // Only one position
    const positions = await getOpenPositions(synapseDb)
    expect(positions).toHaveLength(1)
  })

  it('skips hold signals', async () => {
    await cortexDb.insertInto('signals').values({
      id: 'sig-hold',
      token_id: 'bitcoin',
      signal_type: 'hold',
      confidence: 0.9,
      reasoning: 'neutral',
      timeframe: 'short',
    }).execute()

    await pollSignals(makeCtx())

    const positions = await getOpenPositions(synapseDb)
    expect(positions).toHaveLength(0)
    expect(await isSignalProcessed(synapseDb, 'sig-hold')).toBe(true)
  })

  it('closes position on sell signal', async () => {
    // First open a position
    await cortexDb.insertInto('signals').values({
      id: 'sig-b',
      token_id: 'bitcoin',
      signal_type: 'buy',
      confidence: 0.7,
      reasoning: 'bullish',
      timeframe: 'short',
    }).execute()

    const ctx = makeCtx()
    await pollSignals(ctx)
    expect(await getOpenPositions(synapseDb)).toHaveLength(1)

    // Now replace with a sell signal (latest per token)
    await cortexDb.insertInto('signals').values({
      id: 'sig-s',
      token_id: 'bitcoin',
      signal_type: 'sell',
      confidence: 0.5,
      reasoning: 'bearish',
      timeframe: 'short',
    }).execute()

    await pollSignals(ctx)
    expect(await getOpenPositions(synapseDb)).toHaveLength(0)
  })

  it('triggers stop-loss during risk check', async () => {
    // Open position
    await cortexDb.insertInto('signals').values({
      id: 'sig-sl',
      token_id: 'bitcoin',
      signal_type: 'buy',
      confidence: 0.7,
      reasoning: 'bullish',
      timeframe: 'short',
    }).execute()

    const ctx = makeCtx()
    await pollSignals(ctx)

    // Price crashes below stop-loss (5% for short timeframe: 50000 * 0.95 = 47500)
    executor.prices.set('bitcoin', 45000)
    await cortexDb.updateTable('price_snapshots')
      .set({ price_usd: 45000 })
      .where('token_id', '=', 'bitcoin')
      .execute()

    await runRiskCheck(ctx)

    expect(await getOpenPositions(synapseDb)).toHaveLength(0)
    expect(logs.some((l) => l.includes('STOP_LOSS'))).toBe(true)
  })

  it('halts trading on max drawdown', async () => {
    // Open a large position
    await cortexDb.insertInto('signals').values({
      id: 'sig-dd',
      token_id: 'bitcoin',
      signal_type: 'buy',
      confidence: 0.95,
      reasoning: 'very bullish',
      timeframe: 'long',
    }).execute()

    const ctx = makeCtx()
    await pollSignals(ctx)

    // Crash price hard enough to cause >15% portfolio drawdown after stop-loss close
    executor.prices.set('bitcoin', 10000)
    await cortexDb.updateTable('price_snapshots')
      .set({ price_usd: 10000 })
      .where('token_id', '=', 'bitcoin')
      .execute()

    await runRiskCheck(ctx)

    const state = await getPortfolioState(synapseDb)
    expect(state!.halted).toBe(1)
    expect(await getOpenPositions(synapseDb)).toHaveLength(0)
  })
})
