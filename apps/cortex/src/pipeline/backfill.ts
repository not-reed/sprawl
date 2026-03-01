import type { Kysely } from 'kysely'
import { MemoryManager } from '@repo/cairn'
import type { Database } from '../db/schema.js'
import { fetchHistoricalPrices } from '../ingest/prices.js'
import { fetchCryptoPanicHistorical, fetchRSSNews } from '../ingest/news.js'
import { env } from '../env.js'
import { sql } from 'kysely'
import {
  getActiveTokens,
  insertPriceSnapshot,
  insertNewsItem,
  getOrCreateConversation,
  saveMessage,
  getStats,
} from '../db/queries.js'
import type { HistoricalPricePoint, NewsData } from '../ingest/types.js'

interface BackfillResult {
  days: number
  priceSnapshots: number
  newsItems: number
  memoriesCreated: number
  graphNodes: number
  graphEdges: number
}

/**
 * Backfill historical data and run it through the cairn pipeline.
 * Groups data into weekly batches, runs observer/reflector per batch.
 */
export type BackfillScope = 'all' | 'news' | 'prices'

export async function runBackfill(
  db: Kysely<Database>,
  memory: MemoryManager,
  days: number,
  log: (msg: string) => void,
  scope: BackfillScope = 'all',
): Promise<BackfillResult> {
  const statsBefore = await getStats(db as any)
  const tokens = await getActiveTokens(db as any)
  const skipPrices = scope === 'news'
  const skipNews = scope === 'prices'

  log(`Starting ${days}-day backfill (${scope}) for ${tokens.length} tokens...`)

  // 1. Fetch and store historical prices
  let priceCount = 0
  const allPriceData: Map<string, HistoricalPricePoint[]> = new Map()

  if (!skipPrices) {
    for (const token of tokens) {
      try {
        log(`Fetching ${days}d price history for ${token.symbol}...`)
        const history = await fetchHistoricalPrices(token.id, days, { retries: 5, log })
        allPriceData.set(token.id, history)

        for (const point of history) {
          await insertPriceSnapshot(db as any, {
            token_id: token.id,
            price_usd: point.price,
            market_cap: point.marketCap,
            volume_24h: point.volume,
            change_24h: null,
            change_7d: null,
            captured_at: new Date(point.timestamp).toISOString().replace('T', ' ').replace('Z', ''),
          })
          priceCount++
        }

        // Rate limit: CoinGecko free tier
        await sleep(2000)
      } catch (err) {
        log(`Price fetch failed for ${token.symbol}, skipping: ${err}`)
      }
    }

    log(`Stored ${priceCount} price snapshots`)
  }

  // 2. Fetch and store historical news
  let newsCount = 0
  let allNews: NewsData[] = []

  if (!skipNews) {
    const seenTitles = new Set<string>()

    if (env.CRYPTOPANIC_API_KEY) {
      log('Fetching historical news from CryptoPanic...')
      const pages = Math.min(20, Math.ceil(days / 7))
      try {
        const cpNews = await fetchCryptoPanicHistorical(env.CRYPTOPANIC_API_KEY, pages)
        for (const item of cpNews) {
          seenTitles.add(item.title.toLowerCase())
          allNews.push(item)
        }
      } catch (err) {
        log(`CryptoPanic historical fetch failed: ${err}`)
      }
    }

    // Always supplement with RSS
    log('Fetching news from RSS feeds...')
    try {
      const rssNews = await fetchRSSNews()
      for (const item of rssNews) {
        if (!seenTitles.has(item.title.toLowerCase())) {
          allNews.push(item)
        }
      }
    } catch (err) {
      log(`RSS fetch failed: ${err}`)
    }

    for (const item of allNews) {
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
      if (inserted) newsCount++
    }

    log(`Stored ${newsCount} news items`)
  }

  // 3. Chunk chronologically into weekly batches and run cairn pipeline
  const priceConvId = !skipPrices ? await getOrCreateConversation(db as any, 'cortex', 'prices') : null
  const newsConvId = !skipNews ? await getOrCreateConversation(db as any, 'cortex', 'news') : null

  const weekMs = 7 * 24 * 60 * 60 * 1000
  const endTime = Date.now()
  const startTime = endTime - days * 24 * 60 * 60 * 1000
  const weeks = Math.ceil((endTime - startTime) / weekMs)

  log(`Processing ${weeks} weekly batches through cairn pipeline...`)

  for (let w = 0; w < weeks; w++) {
    const weekStart = startTime + w * weekMs
    const weekEnd = Math.min(weekStart + weekMs, endTime)
    const weekLabel = new Date(weekStart).toISOString().slice(0, 10)

    let wroteMessages = false

    // Compose detailed daily price data for this week
    if (priceConvId) {
      // Skip if already processed
      const existing = await sql<{ cnt: number }>`
        SELECT COUNT(*) as cnt FROM messages
        WHERE conversation_id = ${priceConvId}
          AND content LIKE ${'%Week of ' + weekLabel + '%'}
      `.execute(db)

      if (existing.rows[0]?.cnt === 0) {
        const weekPriceLines: string[] = []
        for (const token of tokens) {
          const history = allPriceData.get(token.id) ?? []
          const weekPoints = history.filter(
            (p) => p.timestamp >= weekStart && p.timestamp < weekEnd,
          )
          if (weekPoints.length === 0) continue

          const first = weekPoints[0]
          const last = weekPoints[weekPoints.length - 1]
          const change = ((last.price - first.price) / first.price) * 100
          const high = Math.max(...weekPoints.map((p) => p.price))
          const low = Math.min(...weekPoints.map((p) => p.price))

          weekPriceLines.push(
            `${token.symbol} weekly: $${first.price.toFixed(2)} → $${last.price.toFixed(2)} (${change >= 0 ? '+' : ''}${change.toFixed(1)}%), range $${low.toFixed(2)}-$${high.toFixed(2)}`,
          )

          for (const point of weekPoints) {
            const date = new Date(point.timestamp).toISOString().slice(0, 10)
            const vol = point.volume != null ? `, vol ${formatCompact(point.volume)}` : ''
            const mcap = point.marketCap != null ? `, mcap ${formatCompact(point.marketCap)}` : ''
            weekPriceLines.push(
              `  ${date} ${token.symbol} $${point.price.toFixed(2)}${vol}${mcap}`,
            )
          }
        }

        if (weekPriceLines.length > 0) {
          const msg = `[Week of ${weekLabel}] Price data:\n${weekPriceLines.join('\n')}`
          await saveMessage(db as any, { conversation_id: priceConvId, role: 'user', content: msg })
          wroteMessages = true
        }
      }
    }

    // News is handled in bulk after the weekly loop (see below)

    // Run cairn pipeline every 3 weeks or on the last week
    if ((w + 1) % 3 === 0 || w === weeks - 1) {
      if (priceConvId) {
        const priceObs = await memory.runObserver(priceConvId)
        if (priceObs) {
          await memory.promoteObservations(priceConvId)
          await memory.runReflector(priceConvId)
        }
      }

      log(`  Week ${w + 1}/${weeks} (${weekLabel}) processed + pipeline run`)
    } else if (wroteMessages) {
      log(`  Week ${w + 1}/${weeks} (${weekLabel}) messages saved`)
    } else {
      log(`  Week ${w + 1}/${weeks} (${weekLabel}) skipped (already processed)`)
    }
  }

  // 4. Process news in bulk (not weekly — RSS has no date filtering so items cluster)
  if (newsConvId && allNews.length > 0) {
    // Sort chronologically
    const sorted = [...allNews].sort(
      (a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime(),
    )

    // Batch into chunks of ~20 items each to build substantial messages
    const BATCH_SIZE = 20
    let newsBatchCount = 0

    for (let i = 0; i < sorted.length; i += BATCH_SIZE) {
      const batch = sorted.slice(i, i + BATCH_SIZE)
      const firstDate = batch[0].publishedAt.slice(0, 10)
      const lastDate = batch[batch.length - 1].publishedAt.slice(0, 10)

      // Dedup check
      const existing = await sql<{ cnt: number }>`
        SELECT COUNT(*) as cnt FROM messages
        WHERE conversation_id = ${newsConvId}
          AND content LIKE ${'%News batch ' + (i / BATCH_SIZE + 1) + '%'}
      `.execute(db)
      if (existing.rows[0]?.cnt > 0) continue

      const newsLines = batch.map((n) => {
        const date = n.publishedAt.slice(0, 10)
        const toks = n.tokensMentioned.length > 0
          ? ` [${n.tokensMentioned.join(', ')}]`
          : ''
        return `[${date}] ${n.title} (${n.source})${toks}`
      })

      const msg = `News batch ${i / BATCH_SIZE + 1} (${firstDate} to ${lastDate}, ${batch.length} articles):\n${newsLines.join('\n')}`
      await saveMessage(db as any, { conversation_id: newsConvId, role: 'user', content: msg })
      newsBatchCount++
    }

    if (newsBatchCount > 0) {
      log(`Saved ${newsBatchCount} news batches (${sorted.length} articles) to cairn`)

      // Run pipeline — may need multiple observer passes if lots of news
      let observerRan = true
      while (observerRan) {
        observerRan = await memory.runObserver(newsConvId)
        if (observerRan) {
          await memory.promoteObservations(newsConvId)
          await memory.runReflector(newsConvId)
        }
      }
    }
  }

  const statsAfter = await getStats(db as any)

  const result: BackfillResult = {
    days,
    priceSnapshots: priceCount,
    newsItems: newsCount,
    memoriesCreated: statsAfter.memoryCount - statsBefore.memoryCount,
    graphNodes: statsAfter.nodeCount - statsBefore.nodeCount,
    graphEdges: statsAfter.edgeCount - statsBefore.edgeCount,
  }

  log(
    `Backfill complete: ${result.days} days, ${result.priceSnapshots} prices, ${result.newsItems} news, ` +
      `${result.memoriesCreated} memories, ${result.graphNodes} nodes, ${result.graphEdges} edges`,
  )

  return result
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatCompact(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}
