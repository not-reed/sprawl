import type { Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import type { Database, PriceSnapshot, NewsItem, Signal, TrackedToken, Command } from './schema.js'

// Re-export cairn queries
export {
  storeMemory,
  recallMemories,
  getRecentMemories,
  trackUsage,
  updateMemoryEmbedding,
} from '@repo/cairn'

type DB = Kysely<Database>

// ── Tracked Tokens ──────────────────────────────────────────────────────

export async function getActiveTokens(db: DB): Promise<TrackedToken[]> {
  return db
    .selectFrom('tracked_tokens')
    .selectAll()
    .where('active', '=', 1)
    .execute()
}

export async function upsertTrackedToken(
  db: DB,
  token: { id: string; symbol: string; name: string },
): Promise<void> {
  const existing = await db
    .selectFrom('tracked_tokens')
    .select('id')
    .where('id', '=', token.id)
    .executeTakeFirst()

  if (!existing) {
    await db
      .insertInto('tracked_tokens')
      .values({ id: token.id, symbol: token.symbol, name: token.name })
      .execute()
  }
}

// ── Price Snapshots ─────────────────────────────────────────────────────

export async function insertPriceSnapshot(
  db: DB,
  snapshot: Omit<PriceSnapshot, 'id' | 'captured_at'> & { captured_at?: string },
): Promise<boolean> {
  // Dedup by (token_id, captured_at) — rounded to minute to handle slight timestamp drift
  if (snapshot.captured_at) {
    const rounded = snapshot.captured_at.slice(0, 16) // YYYY-MM-DDTHH:MM
    const existing = await db
      .selectFrom('price_snapshots')
      .select('id')
      .where('token_id', '=', snapshot.token_id)
      .where('captured_at', 'like', `${rounded}%`)
      .executeTakeFirst()
    if (existing) return false
  }

  await db
    .insertInto('price_snapshots')
    .values({
      id: nanoid(),
      token_id: snapshot.token_id,
      price_usd: snapshot.price_usd,
      market_cap: snapshot.market_cap ?? null,
      volume_24h: snapshot.volume_24h ?? null,
      change_24h: snapshot.change_24h ?? null,
      change_7d: snapshot.change_7d ?? null,
      ...(snapshot.captured_at ? { captured_at: snapshot.captured_at } : {}),
    })
    .execute()
  return true
}

export async function getLatestPrices(db: DB): Promise<PriceSnapshot[]> {
  // Latest price per token using a correlated subquery
  const rows = await db
    .selectFrom('price_snapshots as ps')
    .selectAll()
    .where(
      'ps.captured_at',
      '=',
      db
        .selectFrom('price_snapshots as ps2')
        .select(({ fn }) => fn.max('ps2.captured_at').as('max_at'))
        .whereRef('ps2.token_id', '=', 'ps.token_id'),
    )
    .execute()
  return rows as PriceSnapshot[]
}

export async function getRecentPriceSnapshots(
  db: DB,
  tokenId: string,
  limit = 24,
): Promise<PriceSnapshot[]> {
  return db
    .selectFrom('price_snapshots')
    .selectAll()
    .where('token_id', '=', tokenId)
    .orderBy('captured_at', 'desc')
    .limit(limit)
    .execute()
}

// ── News Items ──────────────────────────────────────────────────────────

export async function insertNewsItem(
  db: DB,
  item: Omit<NewsItem, 'id' | 'ingested_at' | 'memory_id'>,
): Promise<boolean> {
  // Returns false if duplicate (external_id or title already exists)
  const existing = await db
    .selectFrom('news_items')
    .select('id')
    .where((eb) =>
      eb.or([
        eb('external_id', '=', item.external_id),
        eb('title', '=', item.title),
      ]),
    )
    .executeTakeFirst()

  if (existing) return false

  await db
    .insertInto('news_items')
    .values({
      id: nanoid(),
      external_id: item.external_id,
      title: item.title,
      url: item.url ?? null,
      source: item.source,
      published_at: item.published_at,
      tokens_mentioned: item.tokens_mentioned ?? null,
      memory_id: null,
    })
    .execute()

  return true
}

export async function getRecentNews(db: DB, limit = 20): Promise<NewsItem[]> {
  return db
    .selectFrom('news_items')
    .selectAll()
    .orderBy('published_at', 'desc')
    .limit(limit)
    .execute()
}

export async function getUnprocessedNews(db: DB): Promise<NewsItem[]> {
  return db
    .selectFrom('news_items')
    .selectAll()
    .where('memory_id', 'is', null)
    .orderBy('published_at', 'asc')
    .execute()
}

export async function linkNewsToMemory(
  db: DB,
  newsId: string,
  memoryId: string,
): Promise<void> {
  await db
    .updateTable('news_items')
    .set({ memory_id: memoryId })
    .where('id', '=', newsId)
    .execute()
}

// ── Signals ─────────────────────────────────────────────────────────────

export async function insertSignal(
  db: DB,
  signal: Omit<Signal, 'id' | 'created_at'>,
): Promise<string> {
  const id = nanoid()
  await db
    .insertInto('signals')
    .values({
      id,
      token_id: signal.token_id,
      signal_type: signal.signal_type,
      confidence: signal.confidence,
      reasoning: signal.reasoning,
      key_factors: signal.key_factors ?? null,
      memory_ids: signal.memory_ids ?? null,
      timeframe: signal.timeframe,
    })
    .execute()
  return id
}

export async function getLatestSignals(db: DB): Promise<Signal[]> {
  // Latest signal per token
  const rows = await db
    .selectFrom('signals as s')
    .selectAll()
    .where(
      's.created_at',
      '=',
      db
        .selectFrom('signals as s2')
        .select(({ fn }) => fn.max('s2.created_at').as('max_at'))
        .whereRef('s2.token_id', '=', 's.token_id'),
    )
    .execute()
  return rows as Signal[]
}

// ── Commands ────────────────────────────────────────────────────────────

export async function getPendingCommands(db: DB): Promise<Command[]> {
  return db
    .selectFrom('commands')
    .selectAll()
    .where('completed_at', 'is', null)
    .orderBy('created_at', 'asc')
    .execute()
}

export async function insertCommand(
  db: DB,
  command: string,
  args?: string,
): Promise<string> {
  const id = nanoid()
  await db
    .insertInto('commands')
    .values({ id, command, args: args ?? null })
    .execute()
  return id
}

export async function markCommandComplete(db: DB, id: string): Promise<void> {
  await db
    .updateTable('commands')
    .set({ completed_at: new Date().toISOString() })
    .where('id', '=', id)
    .execute()
}

// ── Conversations ───────────────────────────────────────────────────────

export async function getOrCreateConversation(
  db: DB,
  source: string,
  externalId: string | null,
): Promise<string> {
  if (externalId) {
    const existing = await db
      .selectFrom('conversations')
      .select('id')
      .where('source', '=', source)
      .where('external_id', '=', externalId)
      .executeTakeFirst()

    if (existing) return existing.id
  }

  const id = nanoid()
  await db
    .insertInto('conversations')
    .values({ id, source, external_id: externalId })
    .execute()

  return id
}

export async function saveMessage(
  db: DB,
  message: { conversation_id: string; role: string; content: string },
): Promise<string> {
  const id = nanoid()
  await db
    .insertInto('messages')
    .values({
      id,
      conversation_id: message.conversation_id,
      role: message.role,
      content: message.content,
    })
    .execute()
  return id
}

// ── Stats ───────────────────────────────────────────────────────────────

export async function getStats(db: DB): Promise<{
  memoryCount: number
  nodeCount: number
  edgeCount: number
  signalCount: number
  newsCount: number
}> {
  const [memories, nodes, edges, signals, news] = await Promise.all([
    db
      .selectFrom('memories')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('archived_at', 'is', null)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('graph_nodes')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('graph_edges')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('signals')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('news_items')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow(),
  ])

  return {
    memoryCount: Number(memories.count),
    nodeCount: Number(nodes.count),
    edgeCount: Number(edges.count),
    signalCount: Number(signals.count),
    newsCount: Number(news.count),
  }
}
