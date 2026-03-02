import type { Generated, Selectable } from 'kysely'

/**
 * Minimal cortex DB schema — only the tables synapse reads.
 * Duplicated to avoid depending on @repo/cortex.
 */
export interface CortexDatabase {
  signals: CortexSignalTable
  price_snapshots: CortexPriceSnapshotTable
  tracked_tokens: CortexTrackedTokenTable
  [key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface CortexSignalTable {
  id: string
  token_id: string
  signal_type: string // "buy" | "sell" | "hold"
  confidence: number
  reasoning: string
  key_factors: string | null
  memory_ids: string | null
  timeframe: Generated<string> // "short" | "long"
  created_at: Generated<string>
}

export type CortexSignal = Selectable<CortexSignalTable>

export interface CortexPriceSnapshotTable {
  id: string
  token_id: string
  price_usd: number
  market_cap: number | null
  volume_24h: number | null
  change_24h: number | null
  change_7d: number | null
  captured_at: Generated<string>
}

export type CortexPriceSnapshot = Selectable<CortexPriceSnapshotTable>

export interface CortexTrackedTokenTable {
  id: string
  symbol: string
  name: string
  active: Generated<number>
  added_at: Generated<string>
}

export type CortexTrackedToken = Selectable<CortexTrackedTokenTable>
