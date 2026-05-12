import { describe, it, expect, beforeEach } from "vitest";
import { Kysely } from "kysely";
import { createDb } from "@repo/db";
import { runMigrations } from "@repo/db/migrate";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Database } from "../db/schema.js";
import type { CortexDatabase } from "../cortex/types.js";
import {
  initPortfolioState,
  getPortfolioState,
  getOpenPositions,
  isSignalProcessed,
} from "../db/queries.js";
import { pollSignals, runRiskCheck } from "../engine/loop.js";
import type { Executor, ExecutionResult } from "../types.js";
import type { Env } from "../env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrateCortexFixture(db: Kysely<CortexDatabase>) {
  const { sql } = await import("kysely");
  await db.schema
    .createTable("tracked_tokens")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("symbol", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("added_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();
  await db.schema
    .createTable("price_snapshots")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("token_id", "text", (col) => col.notNull())
    .addColumn("price_usd", "real", (col) => col.notNull())
    .addColumn("market_cap", "real")
    .addColumn("volume_24h", "real")
    .addColumn("change_24h", "real")
    .addColumn("change_7d", "real")
    .addColumn("captured_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();
  await db.schema
    .createTable("signals")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("token_id", "text", (col) => col.notNull())
    .addColumn("signal_type", "text", (col) => col.notNull())
    .addColumn("confidence", "real", (col) => col.notNull())
    .addColumn("reasoning", "text", (col) => col.notNull())
    .addColumn("key_factors", "text")
    .addColumn("memory_ids", "text")
    .addColumn("timeframe", "text", (col) => col.notNull().defaultTo("short"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();
}

function makeEnv(overrides: Partial<Env> = {}): Env {
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

class MockExecutor implements Executor {
  prices: Map<string, number>;
  constructor(prices: Map<string, number>) {
    this.prices = prices;
  }
  async buy(tokenId: string, amountUsd: number): Promise<ExecutionResult> {
    const price = this.prices.get(tokenId) ?? 1000;
    const quantity = (amountUsd - 0.5) / price;
    return { price_usd: price, quantity, size_usd: amountUsd, gas_usd: 0.5, slippage_bps: 30 };
  }
  async sell(tokenId: string, quantity: number): Promise<ExecutionResult> {
    const price = this.prices.get(tokenId) ?? 1000;
    const sizeUsd = quantity * price - 0.5;
    return { price_usd: price, quantity, size_usd: sizeUsd, gas_usd: 0.5, slippage_bps: 30 };
  }
}

interface TestFixtures {
  synapseDb: Kysely<Database>;
  cortexDb: Kysely<CortexDatabase>;
  executor: MockExecutor;
  logs: string[];
  makeCtx: () => {
    db: Kysely<Database>;
    cortex: any;
    executor: MockExecutor;
    env: Env;
    log: (msg: string) => void;
  };
}

async function setupEngineTest(): Promise<TestFixtures> {
  const logs: string[] = [];
  const synapse = createDb<Database>(":memory:");
  const synapseDb = synapse.db;
  await runMigrations(synapseDb as any, join(__dirname, "..", "db", "migrations"));
  await initPortfolioState(synapseDb, 10000);

  const cortex = createDb<CortexDatabase>(":memory:");
  const cortexDb = cortex.db;
  await migrateCortexFixture(cortexDb);

  await cortexDb
    .insertInto("tracked_tokens")
    .values({ id: "bitcoin", symbol: "BTC", name: "Bitcoin" })
    .execute();
  await cortexDb
    .insertInto("price_snapshots")
    .values({
      id: "ps-1",
      token_id: "bitcoin",
      price_usd: 50000,
      market_cap: null,
      volume_24h: null,
      change_24h: null,
      change_7d: null,
    })
    .execute();

  const executor = new MockExecutor(new Map([["bitcoin", 50000]]));
  const env = makeEnv();

  const cortexReader = {
    db: cortexDb,
    async getLatestSignals() {
      return cortexDb
        .selectFrom("signals as s")
        .selectAll()
        .where(
          "s.created_at",
          "=",
          cortexDb
            .selectFrom("signals as s2")
            .select(({ fn }) => fn.max("s2.created_at").as("max_at"))
            .whereRef("s2.token_id", "=", "s.token_id"),
        )
        .execute();
    },
    async getLatestPrices() {
      return cortexDb
        .selectFrom("price_snapshots as ps")
        .selectAll()
        .where(
          "ps.captured_at",
          "=",
          cortexDb
            .selectFrom("price_snapshots as ps2")
            .select(({ fn }) => fn.max("ps2.captured_at").as("max_at"))
            .whereRef("ps2.token_id", "=", "ps.token_id"),
        )
        .execute();
    },
    async getTokenPrice(tokenId: string) {
      return cortexDb
        .selectFrom("price_snapshots")
        .selectAll()
        .where("token_id", "=", tokenId)
        .orderBy("captured_at", "desc")
        .limit(1)
        .executeTakeFirst();
    },
    async getActiveTokens() {
      return cortexDb.selectFrom("tracked_tokens").selectAll().where("active", "=", 1).execute();
    },
    async destroy() {},
  };

  function makeCtx() {
    return {
      db: synapseDb,
      cortex: cortexReader as any,
      executor,
      env,
      log: (msg: string) => logs.push(msg),
    };
  }

  return { synapseDb, cortexDb, executor, logs, makeCtx };
}

describe("signal polling", () => {
  let t: TestFixtures;
  beforeEach(async () => {
    t = await setupEngineTest();
  });

  it("opens a position on a buy signal", async () => {
    await t.cortexDb
      .insertInto("signals")
      .values({
        id: "sig-buy-1",
        token_id: "bitcoin",
        signal_type: "buy",
        confidence: 0.7,
        reasoning: "bullish",
        timeframe: "short",
      })
      .execute();
    await pollSignals(t.makeCtx());
    const positions = await getOpenPositions(t.synapseDb);
    expect(positions).toHaveLength(1);
    expect(positions[0].token_id).toBe("bitcoin");
    expect(positions[0].direction).toBe("long");
    expect(await isSignalProcessed(t.synapseDb, "sig-buy-1")).toBe(true);
    const state = await getPortfolioState(t.synapseDb);
    expect(state!.cash_usd).toBeLessThan(10000);
  });

  it("skips already-processed signals", async () => {
    await t.cortexDb
      .insertInto("signals")
      .values({
        id: "sig-dup",
        token_id: "bitcoin",
        signal_type: "buy",
        confidence: 0.7,
        reasoning: "bullish",
        timeframe: "short",
      })
      .execute();
    const ctx = t.makeCtx();
    await pollSignals(ctx);
    await pollSignals(ctx);
    const positions = await getOpenPositions(t.synapseDb);
    expect(positions).toHaveLength(1);
  });

  it("skips hold signals", async () => {
    await t.cortexDb
      .insertInto("signals")
      .values({
        id: "sig-hold",
        token_id: "bitcoin",
        signal_type: "hold",
        confidence: 0.9,
        reasoning: "neutral",
        timeframe: "short",
      })
      .execute();
    await pollSignals(t.makeCtx());
    const positions = await getOpenPositions(t.synapseDb);
    expect(positions).toHaveLength(0);
    expect(await isSignalProcessed(t.synapseDb, "sig-hold")).toBe(true);
  });
});

describe("position management", () => {
  let t: TestFixtures;
  beforeEach(async () => {
    t = await setupEngineTest();
  });

  it("closes position on sell signal", async () => {
    await t.cortexDb
      .insertInto("signals")
      .values({
        id: "sig-b",
        token_id: "bitcoin",
        signal_type: "buy",
        confidence: 0.7,
        reasoning: "bullish",
        timeframe: "short",
      })
      .execute();
    const ctx = t.makeCtx();
    await pollSignals(ctx);
    expect(await getOpenPositions(t.synapseDb)).toHaveLength(1);

    await t.cortexDb
      .insertInto("signals")
      .values({
        id: "sig-s",
        token_id: "bitcoin",
        signal_type: "sell",
        confidence: 0.5,
        reasoning: "bearish",
        timeframe: "short",
      })
      .execute();
    await pollSignals(ctx);
    expect(await getOpenPositions(t.synapseDb)).toHaveLength(0);
  });
});

describe("risk checks", () => {
  let t: TestFixtures;
  beforeEach(async () => {
    t = await setupEngineTest();
  });

  it("triggers stop-loss during risk check", async () => {
    await t.cortexDb
      .insertInto("signals")
      .values({
        id: "sig-sl",
        token_id: "bitcoin",
        signal_type: "buy",
        confidence: 0.7,
        reasoning: "bullish",
        timeframe: "short",
      })
      .execute();
    const ctx = t.makeCtx();
    await pollSignals(ctx);

    t.executor.prices.set("bitcoin", 45000);
    await t.cortexDb
      .updateTable("price_snapshots")
      .set({ price_usd: 45000 })
      .where("token_id", "=", "bitcoin")
      .execute();

    await runRiskCheck(ctx);
    expect(await getOpenPositions(t.synapseDb)).toHaveLength(0);
    expect(t.logs.some((l) => l.includes("STOP_LOSS"))).toBe(true);
  });

  it("halts trading on max drawdown", async () => {
    await t.cortexDb
      .insertInto("signals")
      .values({
        id: "sig-dd",
        token_id: "bitcoin",
        signal_type: "buy",
        confidence: 0.95,
        reasoning: "very bullish",
        timeframe: "long",
      })
      .execute();
    const ctx = t.makeCtx();
    await pollSignals(ctx);

    t.executor.prices.set("bitcoin", 10000);
    await t.cortexDb
      .updateTable("price_snapshots")
      .set({ price_usd: 10000 })
      .where("token_id", "=", "bitcoin")
      .execute();

    await runRiskCheck(ctx);
    const state = await getPortfolioState(t.synapseDb);
    expect(state!.halted).toBe(1);
    expect(await getOpenPositions(t.synapseDb)).toHaveLength(0);
  });
});
