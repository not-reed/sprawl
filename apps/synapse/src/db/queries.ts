import type { Kysely } from "kysely";
import { nanoid } from "nanoid";
import type {
  Database,
  PortfolioState,
  Position,
  NewPosition,
  Trade,
  NewTrade,
  NewSnapshot,
  NewSignalLog,
  NewRiskEvent,
} from "./schema.js";

type DB = Kysely<Database>;

// ── Portfolio State ─────────────────────────────────────────────────────

export async function getPortfolioState(db: DB): Promise<PortfolioState | undefined> {
  return db.selectFrom("portfolio_state").selectAll().where("id", "=", 1).executeTakeFirst();
}

export async function initPortfolioState(db: DB, initialBalanceUsd: number): Promise<void> {
  const existing = await getPortfolioState(db);
  if (existing) return;

  await db
    .insertInto("portfolio_state")
    .values({
      cash_usd: initialBalanceUsd,
      total_value_usd: initialBalanceUsd,
      high_water_mark_usd: initialBalanceUsd,
      drawdown_pct: 0,
    })
    .execute();
}

export async function updatePortfolioState(
  db: DB,
  updates: {
    cash_usd?: number;
    total_value_usd?: number;
    high_water_mark_usd?: number;
    drawdown_pct?: number;
    halted?: number;
  },
): Promise<void> {
  await db
    .updateTable("portfolio_state")
    .set({ ...updates, updated_at: new Date().toISOString() })
    .where("id", "=", 1)
    .execute();
}

// ── Positions ───────────────────────────────────────────────────────────

export async function getOpenPositions(db: DB): Promise<Position[]> {
  return db.selectFrom("positions").selectAll().where("closed_at", "is", null).execute();
}

export async function getOpenPositionByToken(
  db: DB,
  tokenId: string,
): Promise<Position | undefined> {
  return db
    .selectFrom("positions")
    .selectAll()
    .where("token_id", "=", tokenId)
    .where("closed_at", "is", null)
    .executeTakeFirst();
}

export async function insertPosition(db: DB, position: NewPosition): Promise<string> {
  const id = position.id ?? nanoid();
  await db
    .insertInto("positions")
    .values({ ...position, id })
    .execute();
  return id;
}

export async function updatePosition(
  db: DB,
  id: string,
  updates: {
    current_price_usd?: number;
    unrealized_pnl_usd?: number;
    realized_pnl_usd?: number;
    closed_at?: string;
  },
): Promise<void> {
  await db.updateTable("positions").set(updates).where("id", "=", id).execute();
}

// ── Trades ──────────────────────────────────────────────────────────────

export async function insertTrade(db: DB, trade: Omit<NewTrade, "id">): Promise<string> {
  const id = nanoid();
  await db
    .insertInto("trades")
    .values({ ...trade, id })
    .execute();
  return id;
}

export async function getTradesByPosition(db: DB, positionId: string): Promise<Trade[]> {
  return db
    .selectFrom("trades")
    .selectAll()
    .where("position_id", "=", positionId)
    .orderBy("executed_at", "asc")
    .execute();
}

// ── Snapshots ───────────────────────────────────────────────────────────

export async function insertSnapshot(db: DB, snapshot: Omit<NewSnapshot, "id">): Promise<string> {
  const id = nanoid();
  await db
    .insertInto("snapshots")
    .values({ ...snapshot, id })
    .execute();
  return id;
}

export async function getLatestSnapshot(
  db: DB,
): Promise<import("./schema.js").Snapshot | undefined> {
  return db
    .selectFrom("snapshots")
    .selectAll()
    .orderBy("captured_at", "desc")
    .limit(1)
    .executeTakeFirst();
}

// ── Signal Log ──────────────────────────────────────────────────────────

export async function isSignalProcessed(db: DB, cortexSignalId: string): Promise<boolean> {
  const row = await db
    .selectFrom("signal_log")
    .select("id")
    .where("cortex_signal_id", "=", cortexSignalId)
    .executeTakeFirst();
  return !!row;
}

export async function logSignal(db: DB, entry: Omit<NewSignalLog, "id">): Promise<string> {
  const id = nanoid();
  await db
    .insertInto("signal_log")
    .values({ ...entry, id })
    .execute();
  return id;
}

// ── Risk Events ─────────────────────────────────────────────────────────

export async function logRiskEvent(db: DB, event: Omit<NewRiskEvent, "id">): Promise<string> {
  const id = nanoid();
  await db
    .insertInto("risk_events")
    .values({ ...event, id })
    .execute();
  return id;
}

export async function getRecentRiskEvents(
  db: DB,
  limit = 20,
): Promise<import("./schema.js").RiskEvent[]> {
  return db
    .selectFrom("risk_events")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}
