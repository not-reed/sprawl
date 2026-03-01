import { Cron } from 'croner'
import type { Kysely } from 'kysely'
import { MemoryManager } from '@repo/cairn'
import type { Database } from '../db/schema.js'
import { fetchPrices } from '../ingest/prices.js'
import { fetchNews } from '../ingest/news.js'
import { env } from '../env.js'
import {
  getActiveTokens,
  insertPriceSnapshot,
  insertNewsItem,
  getOrCreateConversation,
  saveMessage,
  getPendingCommands,
  markCommandComplete,
} from '../db/queries.js'
import { analyzeAllTokens } from './analyzer.js'
import type { PriceData } from '../ingest/types.js'

const jobs: Cron[] = []

// Conversation IDs are cached after first creation
let priceConvId: string | null = null
let newsConvId: string | null = null

export interface LoopContext {
  db: Kysely<Database>
  memory: MemoryManager
  log: (msg: string) => void
}

export function startLoop(ctx: LoopContext): void {
  const { db, memory, log } = ctx

  // Price ingestion
  const priceJob = new Cron(`*/${Math.max(1, Math.floor(env.PRICE_INTERVAL / 60))} * * * *`, async () => {
    try {
      await ingestPrices(db, memory, log)
    } catch (err) {
      log(`Price ingestion error: ${err}`)
    }
  })
  jobs.push(priceJob)

  // News ingestion
  const newsJob = new Cron(`*/${Math.max(1, Math.floor(env.NEWS_INTERVAL / 60))} * * * *`, async () => {
    try {
      await ingestNews(db, memory, log)
    } catch (err) {
      log(`News ingestion error: ${err}`)
    }
  })
  jobs.push(newsJob)

  // Signal generation
  const signalJob = new Cron(`*/${Math.max(1, Math.floor(env.SIGNAL_INTERVAL / 60))} * * * *`, async () => {
    try {
      await analyzeAllTokens(db, memory, log)
    } catch (err) {
      log(`Signal generation error: ${err}`)
    }
  })
  jobs.push(signalJob)

  // Command queue polling
  const commandJob = new Cron('*/10 * * * * *', async () => {
    try {
      await processCommandQueue(db, memory, log)
    } catch (err) {
      log(`Command queue error: ${err}`)
    }
  })
  jobs.push(commandJob)

  log(`Pipeline started: prices every ${env.PRICE_INTERVAL}s, news every ${env.NEWS_INTERVAL}s, signals every ${env.SIGNAL_INTERVAL}s, commands every 10s`)
}

export function stopLoop(): void {
  for (const job of jobs) {
    job.stop()
  }
  jobs.length = 0
}

/**
 * Run a single price ingestion cycle. Exported for manual triggering.
 */
export async function ingestPrices(
  db: Kysely<Database>,
  memory: MemoryManager,
  log: (msg: string) => void,
): Promise<PriceData[]> {
  const tokens = await getActiveTokens(db as any)
  if (tokens.length === 0) return []

  const tokenIds = tokens.map((t) => t.id)
  const prices = await fetchPrices(tokenIds)

  // Store snapshots
  for (const p of prices) {
    await insertPriceSnapshot(db as any, {
      token_id: p.tokenId,
      price_usd: p.priceUsd,
      market_cap: p.marketCap,
      volume_24h: p.volume24h,
      change_24h: p.change24h,
      change_7d: p.change7d,
    })
  }

  // Compose and save message for cairn
  if (prices.length > 0) {
    if (!priceConvId) {
      priceConvId = await getOrCreateConversation(db as any, 'cortex', 'prices')
    }

    const msg = composePriceMessage(prices, tokens)
    await saveMessage(db as any, {
      conversation_id: priceConvId,
      role: 'user',
      content: msg,
    })

    // Run cairn pipeline
    await memory.runObserver(priceConvId)
    await memory.promoteObservations(priceConvId)
    await memory.runReflector(priceConvId)
  }

  log(`Ingested prices for ${prices.length} tokens`)
  return prices
}

/**
 * Run a single news ingestion cycle. Exported for manual triggering.
 */
export async function ingestNews(
  db: Kysely<Database>,
  memory: MemoryManager,
  log: (msg: string) => void,
): Promise<number> {
  const tokens = await getActiveTokens(db as any)
  const currencies = tokens.map((t) => t.symbol).join(',')
  const news = await fetchNews(env.CRYPTOPANIC_API_KEY, currencies, env.CRYPTOCOMPARE_API_KEY, log)
  let newCount = 0

  for (const item of news) {
    const inserted = await insertNewsItem(db as any, {
      external_id: item.externalId,
      title: item.title,
      url: item.url,
      source: item.source,
      published_at: item.publishedAt,
      tokens_mentioned: item.tokensMentioned.length > 0
        ? JSON.stringify(item.tokensMentioned)
        : null,
    })
    if (inserted) newCount++
  }

  // Compose and save message for cairn
  if (newCount > 0) {
    if (!newsConvId) {
      newsConvId = await getOrCreateConversation(db as any, 'cortex', 'news')
    }

    const tokens = await getActiveTokens(db as any)
    const msg = composeNewsMessage(
      news.slice(0, 10),
      tokens.map((t) => t.symbol),
    )
    await saveMessage(db as any, {
      conversation_id: newsConvId,
      role: 'user',
      content: msg,
    })

    // Run cairn pipeline
    await memory.runObserver(newsConvId)
    await memory.promoteObservations(newsConvId)
    await memory.runReflector(newsConvId)
  }

  log(`Ingested ${newCount} new articles (${news.length} total fetched)`)
  return newCount
}

// ── Command Queue ───────────────────────────────────────────────────────

async function processCommandQueue(
  db: Kysely<Database>,
  memory: MemoryManager,
  log: (msg: string) => void,
): Promise<void> {
  const pending = await getPendingCommands(db as any)
  if (pending.length === 0) return

  for (const cmd of pending) {
    switch (cmd.command) {
      case 'analyze':
        log(`Executing queued analyze command (${cmd.id})`)
        await analyzeAllTokens(db, memory, log)
        break
      default:
        log(`Unknown command: ${cmd.command}`)
    }
    await markCommandComplete(db as any, cmd.id)
  }
}

// ── Message Composition ─────────────────────────────────────────────────

function composePriceMessage(
  prices: PriceData[],
  tokens: Array<{ id: string; symbol: string }>,
): string {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const symbolMap = new Map(tokens.map((t) => [t.id, t.symbol]))

  const lines = prices.map((p) => {
    const sym = symbolMap.get(p.tokenId) ?? p.tokenId
    const price = formatUsd(p.priceUsd)
    const parts = [`${sym} ${price}`]
    if (p.change24h != null) parts.push(`${formatPct(p.change24h)} 24h`)
    if (p.change7d != null) parts.push(`${formatPct(p.change7d)} 7d`)
    if (p.volume24h != null) parts.push(`vol ${formatCompact(p.volume24h)}`)
    return parts.join(', ')
  })

  return `[${now}] ${lines.join('. ')}.`
}

export function composeNewsMessage(
  news: Array<{ title: string; source: string; tokensMentioned: string[] }>,
  _trackedSymbols: string[],
): string {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const lines = news.map((n) => {
    const tokens = n.tokensMentioned.length > 0
      ? ` Tokens: ${n.tokensMentioned.join(', ')}.`
      : ''
    return `- ${n.title} (${n.source})${tokens}`
  })

  return `[${now}] News:\n${lines.join('\n')}`
}

// ── Formatting Helpers ──────────────────────────────────────────────────

function formatUsd(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toPrecision(4)}`
}

function formatPct(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

function formatCompact(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}
