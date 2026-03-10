import type { Generated, Insertable, Selectable } from "kysely";
import type { CairnDatabase } from "@repo/cairn";

export interface Database extends CairnDatabase {
  tracked_tokens: TrackedTokenTable;
  price_snapshots: PriceSnapshotTable;
  news_items: NewsItemTable;
  signals: SignalTable;
  commands: CommandTable;
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface TrackedTokenTable {
  id: string; // CoinGecko ID e.g. "bitcoin"
  symbol: string; // e.g. "BTC"
  name: string; // e.g. "Bitcoin"
  active: Generated<number>;
  added_at: Generated<string>;
}

export type TrackedToken = Selectable<TrackedTokenTable>;
export type NewTrackedToken = Insertable<TrackedTokenTable>;

export interface PriceSnapshotTable {
  id: string;
  token_id: string;
  price_usd: number;
  market_cap: number | null;
  volume_24h: number | null;
  change_24h: number | null;
  change_7d: number | null;
  captured_at: Generated<string>;
}

export type PriceSnapshot = Selectable<PriceSnapshotTable>;
export type NewPriceSnapshot = Insertable<PriceSnapshotTable>;

export interface NewsItemTable {
  id: string;
  external_id: string;
  title: string;
  url: string | null;
  source: string;
  published_at: string;
  tokens_mentioned: string | null; // JSON array
  ingested_at: Generated<string>;
  memory_id: string | null;
}

export type NewsItem = Selectable<NewsItemTable>;
export type NewNewsItem = Insertable<NewsItemTable>;

export interface SignalTable {
  id: string;
  token_id: string;
  signal_type: string; // "buy" | "sell" | "hold"
  confidence: number;
  reasoning: string;
  key_factors: string | null; // JSON array
  memory_ids: string | null; // JSON array
  timeframe: Generated<string>; // "short" (24-48h) | "long" (1-4 weeks)
  created_at: Generated<string>;
}

export type Signal = Selectable<SignalTable>;
export type NewSignal = Insertable<SignalTable>;

export interface CommandTable {
  id: string;
  command: string;
  args: string | null;
  created_at: Generated<string>;
  completed_at: string | null;
}

export type Command = Selectable<CommandTable>;
export type NewCommand = Insertable<CommandTable>;
