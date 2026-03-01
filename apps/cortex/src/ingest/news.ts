import { XMLParser } from 'fast-xml-parser'
import type { NewsData } from './types.js'

const CRYPTOPANIC_BASE = 'https://cryptopanic.com/api/v1'

// RSS feeds — always fetched as supplemental source
const RSS_FEEDS: Array<{ url: string; source: string }> = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'rss:coindesk' },
  { url: 'https://cointelegraph.com/rss', source: 'rss:cointelegraph' },
  { url: 'https://www.theblock.co/rss.xml', source: 'rss:theblock' },
  { url: 'https://decrypt.co/feed', source: 'rss:decrypt' },
  { url: 'https://www.dlnews.com/arc/outboundfeeds/rss/', source: 'rss:dlnews' },
  { url: 'https://thedefiant.io/feed/', source: 'rss:thedefiant' },
  { url: 'https://cryptoslate.com/feed/', source: 'rss:cryptoslate' },
  { url: 'https://cryptonews.com/news/feed/', source: 'rss:cryptonews' },
]

/**
 * Fetch news from CryptoPanic API.
 * Free tier: ~5 req/min, supports date filtering + token filtering.
 */
export async function fetchCryptoPanicNews(
  apiKey: string,
  opts?: { currencies?: string; filter?: string },
): Promise<NewsData[]> {
  const params = new URLSearchParams({
    auth_token: apiKey,
    kind: 'news',
    public: 'true',
  })
  if (opts?.filter) params.set('filter', opts.filter)
  if (opts?.currencies) params.set('currencies', opts.currencies)

  const url = `${CRYPTOPANIC_BASE}/posts/?${params}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`CryptoPanic error: ${res.status}`)
  }
  assertJsonResponse(res, 'CryptoPanic')

  const data = (await res.json()) as {
    results: Array<{
      id: number
      title: string
      url: string
      source: { title: string }
      published_at: string
      currencies?: Array<{ code: string }>
    }>
  }

  return data.results.map((item) => ({
    externalId: `cp:${item.id}`,
    title: item.title,
    url: item.url,
    source: 'cryptopanic',
    publishedAt: item.published_at,
    tokensMentioned: item.currencies?.map((c) => c.code) ?? [],
  }))
}

/**
 * Fetch historical news from CryptoPanic (paginated).
 */
export async function fetchCryptoPanicHistorical(
  apiKey: string,
  pages: number = 5,
  log?: (msg: string) => void,
): Promise<NewsData[]> {
  const allNews: NewsData[] = []
  let nextUrl: string | null = null
  const emit = log ?? ((msg: string) => console.error(`[cortex] ${msg}`))

  for (let page = 0; page < pages; page++) {
    const url =
      nextUrl ??
      `${CRYPTOPANIC_BASE}/posts/?auth_token=${apiKey}&kind=news&public=true`

    const res = await fetch(url)
    if (!res.ok) {
      const detail = res.status === 401 ? 'check API key'
        : res.status === 403 ? 'access forbidden (blocked?)'
        : `HTTP ${res.status}`
      emit(`CryptoPanic page ${page}: ${detail}`)
      break
    }
    if (!isJsonResponse(res)) {
      emit(`CryptoPanic page ${page} returned non-JSON (Cloudflare challenge?)`)
      break
    }

    const data = (await res.json()) as {
      results: Array<{
        id: number
        title: string
        url: string
        source: { title: string }
        published_at: string
        currencies?: Array<{ code: string }>
      }>
      next: string | null
    }

    for (const item of data.results) {
      allNews.push({
        externalId: `cp:${item.id}`,
        title: item.title,
        url: item.url,
        source: 'cryptopanic',
        publishedAt: item.published_at,
        tokensMentioned: item.currencies?.map((c) => c.code) ?? [],
      })
    }

    nextUrl = data.next
    if (!nextUrl) break

    // Rate limit: ~5 req/min
    await sleep(1200)
  }

  return allNews
}

/**
 * Fetch news from CryptoCompare News API.
 * Free tier (no key): lower rate limit. With key: higher rate limit.
 * Returns structured JSON with coin tagging built-in.
 */
export async function fetchCryptoCompareNews(apiKey?: string): Promise<NewsData[]> {
  const url = new URL('https://min-api.cryptocompare.com/data/v2/news/')
  url.searchParams.set('lang', 'EN')
  if (apiKey) url.searchParams.set('api_key', apiKey)

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`CryptoCompare error: ${res.status}`)
  }
  assertJsonResponse(res, 'CryptoCompare')

  const data = (await res.json()) as {
    Data: Array<{
      id: string
      title: string
      url: string
      source: string
      published_on: number // unix timestamp
      categories: string // comma-separated coin symbols
    }>
  }

  return (data.Data ?? []).map((item) => ({
    externalId: `cc:${item.id}`,
    title: item.title,
    url: item.url,
    source: `cryptocompare:${item.source}`,
    publishedAt: new Date(item.published_on * 1000).toISOString(),
    tokensMentioned: item.categories
      ? item.categories.split('|').filter((c) => c.length <= 6 && c === c.toUpperCase())
      : [],
  }))
}

/**
 * Fetch news from RSS feeds.
 */
export async function fetchRSSNews(): Promise<NewsData[]> {
  const parser = new XMLParser({ ignoreAttributes: false })
  const allNews: NewsData[] = []

  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed.url)
      if (!res.ok) continue

      const xml = await res.text()
      if (looksLikeHtml(xml)) {
        console.error(`[cortex] RSS feed ${feed.source} returned HTML (Cloudflare?), skipping`)
        continue
      }
      const parsed = parser.parse(xml)

      const items =
        parsed?.rss?.channel?.item ??
        parsed?.feed?.entry ??
        []

      const itemArray = Array.isArray(items) ? items : [items]

      for (const item of itemArray.slice(0, 50)) {
        const title = item.title?.toString() ?? ''
        const link = item.link?.['@_href'] ?? item.link?.toString() ?? null
        const pubDate =
          item.pubDate ?? item.published ?? item.updated ?? new Date().toISOString()

        if (!title) continue

        allNews.push({
          externalId: `${feed.source}:${hashString(title)}`,
          title,
          url: link,
          source: feed.source,
          publishedAt: new Date(pubDate).toISOString(),
          tokensMentioned: extractTokenMentions(title),
        })
      }
    } catch (err) {
      console.error(`[cortex] RSS feed ${feed.source} failed: ${err}`)
    }
  }

  return allNews
}

/**
 * Fetch news from all available sources. Deduplicates by title hash.
 * Sources: CryptoPanic (if key), CryptoCompare (free), RSS (8 feeds).
 */
export async function fetchNews(
  cryptoPanicKey?: string,
  currencies?: string,
  cryptoCompareKey?: string,
  log?: (msg: string) => void,
): Promise<NewsData[]> {
  const allNews: NewsData[] = []
  const seen = new Set<string>()
  const emit = log ?? ((msg: string) => console.error(`[cortex] ${msg}`))

  const addItems = (items: NewsData[]) => {
    for (const item of items) {
      const key = item.title.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        allNews.push(item)
      }
    }
  }

  // CryptoPanic (if key available)
  if (cryptoPanicKey) {
    try {
      addItems(await fetchCryptoPanicNews(cryptoPanicKey, { currencies, filter: 'rising' }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('401')) emit(`CryptoPanic: 401 — check API key`)
      else if (msg.includes('403')) emit(`CryptoPanic: 403 — access forbidden`)
      else if (msg.includes('non-JSON')) emit(`CryptoPanic: blocked by Cloudflare`)
      else emit(`CryptoPanic fetch failed: ${msg}`)
    }
  }

  // CryptoCompare (free, always runs)
  try {
    addItems(await fetchCryptoCompareNews(cryptoCompareKey))
  } catch (err) {
    emit(`CryptoCompare fetch failed: ${err}`)
  }

  // RSS always runs as supplement
  try {
    addItems(await fetchRSSNews())
  } catch (err) {
    emit(`RSS fetch failed: ${err}`)
  }

  return allNews
}

// Simple string hash for dedup IDs
function hashString(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

// Extract common crypto token mentions from text
const TOKEN_PATTERNS: Record<string, RegExp> = {
  BTC: /\b(BTC|Bitcoin)\b/i,
  ETH: /\b(ETH|Ethereum)\b/i,
  SOL: /\b(SOL|Solana)\b/i,
  XRP: /\b(XRP|Ripple)\b/i,
  ADA: /\b(ADA|Cardano)\b/i,
  DOGE: /\b(DOGE|Dogecoin)\b/i,
  DOT: /\b(DOT|Polkadot)\b/i,
  AVAX: /\b(AVAX|Avalanche)\b/i,
  LINK: /\b(LINK|Chainlink)\b/i,
  MATIC: /\b(MATIC|Polygon)\b/i,
}

function extractTokenMentions(text: string): string[] {
  return Object.entries(TOKEN_PATTERNS)
    .filter(([, regex]) => regex.test(text))
    .map(([symbol]) => symbol)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Check if a response has a JSON content-type */
function isJsonResponse(res: Response): boolean {
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json')
}

/** Throw if response isn't JSON (Cloudflare challenge pages, etc.) */
function assertJsonResponse(res: Response, source: string): void {
  if (!isJsonResponse(res)) {
    throw new Error(`${source} returned non-JSON content-type: ${res.headers.get('content-type')}`)
  }
}

/** Detect HTML responses (Cloudflare challenges, error pages) */
function looksLikeHtml(text: string): boolean {
  const start = text.trimStart().slice(0, 100).toLowerCase()
  return start.startsWith('<!doctype') || start.startsWith('<html')
}
