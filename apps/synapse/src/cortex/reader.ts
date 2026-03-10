import { createDb } from "@repo/db";
import type { Kysely } from "kysely";
import type {
  CortexDatabase,
  CortexSignal,
  CortexPriceSnapshot,
  CortexTrackedToken,
} from "./types.js";

/**
 * Read-only connection to cortex.db for fetching signals and prices.
 */
export class CortexReader {
  readonly db: Kysely<CortexDatabase>;

  constructor(databaseUrl: string) {
    const { db } = createDb<CortexDatabase>(databaseUrl);
    this.db = db;
  }

  /** Latest signal per token. */
  async getLatestSignals(): Promise<CortexSignal[]> {
    const rows = await this.db
      .selectFrom("signals as s")
      .selectAll()
      .where(
        "s.created_at",
        "=",
        this.db
          .selectFrom("signals as s2")
          .select(({ fn }) => fn.max("s2.created_at").as("max_at"))
          .whereRef("s2.token_id", "=", "s.token_id"),
      )
      .execute();
    return rows as CortexSignal[];
  }

  /** All signals created after a given timestamp. */
  async getSignalsSince(since: string): Promise<CortexSignal[]> {
    return this.db
      .selectFrom("signals")
      .selectAll()
      .where("created_at", ">", since)
      .orderBy("created_at", "asc")
      .execute();
  }

  /** Latest price per token (correlated subquery). */
  async getLatestPrices(): Promise<CortexPriceSnapshot[]> {
    const rows = await this.db
      .selectFrom("price_snapshots as ps")
      .selectAll()
      .where(
        "ps.captured_at",
        "=",
        this.db
          .selectFrom("price_snapshots as ps2")
          .select(({ fn }) => fn.max("ps2.captured_at").as("max_at"))
          .whereRef("ps2.token_id", "=", "ps.token_id"),
      )
      .execute();
    return rows as CortexPriceSnapshot[];
  }

  /** Get latest price for a specific token. */
  async getTokenPrice(tokenId: string): Promise<CortexPriceSnapshot | undefined> {
    return this.db
      .selectFrom("price_snapshots")
      .selectAll()
      .where("token_id", "=", tokenId)
      .orderBy("captured_at", "desc")
      .limit(1)
      .executeTakeFirst();
  }

  /** Get active tracked tokens. */
  async getActiveTokens(): Promise<CortexTrackedToken[]> {
    return this.db.selectFrom("tracked_tokens").selectAll().where("active", "=", 1).execute();
  }

  async destroy(): Promise<void> {
    await this.db.destroy();
  }
}
