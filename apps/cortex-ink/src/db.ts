import { DatabaseSync } from 'node:sqlite'

export interface PriceRow {
  symbol: string
  name: string
  price_usd: number
  market_cap: number | null
  volume_24h: number | null
  change_24h: number | null
  change_7d: number | null
  captured_at: string
}

export interface SparklineRow {
  price_usd: number
  captured_at: string
}

export interface NewsRow {
  title: string
  source: string
  published_at: string
  tokens_mentioned: string | null
  memory_id: string | null
}

export interface SignalRow {
  symbol: string
  signal_type: string
  confidence: number
  reasoning: string
  key_factors: string | null
  created_at: string
}

export interface GraphRow {
  source_label: string
  relation: string
  target_label: string
  weight: number
}

export interface StatsRow {
  memories: number
  nodes: number
  edges: number
  signals: number
  news: number
}

export function openDb(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  db.exec('PRAGMA journal_mode = WAL')

  const queries = {
    prices: db.prepare(`
      SELECT t.symbol, t.name, p.price_usd, p.market_cap, p.volume_24h,
             p.change_24h, p.change_7d, p.captured_at
      FROM price_snapshots p
      JOIN tracked_tokens t ON t.id = p.token_id
      WHERE p.captured_at = (
        SELECT MAX(p2.captured_at) FROM price_snapshots p2 WHERE p2.token_id = p.token_id
      )
      ORDER BY p.price_usd DESC
    `),

    sparkline: db.prepare(`
      SELECT price_usd, captured_at FROM price_snapshots
      WHERE token_id = (SELECT id FROM tracked_tokens WHERE symbol = ?)
        AND captured_at > datetime('now', '-24 hours')
      ORDER BY captured_at
    `),

    news: db.prepare(`
      SELECT title, source, published_at, tokens_mentioned, memory_id
      FROM news_items ORDER BY published_at DESC LIMIT 30
    `),

    signals: db.prepare(`
      SELECT t.symbol, s.signal_type, s.confidence, s.reasoning, s.key_factors, s.created_at
      FROM signals s
      JOIN tracked_tokens t ON t.id = s.token_id
      ORDER BY s.created_at DESC LIMIT 20
    `),

    graph: db.prepare(`
      SELECT gn.display_name as source_label, ge.relation, gn2.display_name as target_label, ge.weight
      FROM graph_edges ge
      JOIN graph_nodes gn ON gn.id = ge.source_id
      JOIN graph_nodes gn2 ON gn2.id = ge.target_id
      ORDER BY ge.weight DESC LIMIT 30
    `),

    stats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memories WHERE archived_at IS NULL) as memories,
        (SELECT COUNT(*) FROM graph_nodes) as nodes,
        (SELECT COUNT(*) FROM graph_edges) as edges,
        (SELECT COUNT(*) FROM signals) as signals,
        (SELECT COUNT(*) FROM news_items) as news
    `),

    tokenSymbols: db.prepare(`
      SELECT symbol FROM tracked_tokens WHERE active = 1
    `),
  }

  return {
    getPrices: () => queries.prices.all() as unknown as PriceRow[],
    getSparkline: (symbol: string) => queries.sparkline.all(symbol) as unknown as SparklineRow[],
    getNews: () => queries.news.all() as unknown as NewsRow[],
    getSignals: () => queries.signals.all() as unknown as SignalRow[],
    getGraph: () => queries.graph.all() as unknown as GraphRow[],
    getStats: () => {
      const rows = queries.stats.all() as unknown as StatsRow[]
      return rows[0] ?? { memories: 0, nodes: 0, edges: 0, signals: 0, news: 0 }
    },
    getTokenSymbols: () => (queries.tokenSymbols.all() as unknown as { symbol: string }[]).map(r => r.symbol),
    close: () => db.close(),
  }
}

export type CortexDb = ReturnType<typeof openDb>
