import type { PriceData, HistoricalPricePoint } from './types.js'

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithRetry(
  url: string,
  retries = 3,
  log?: (msg: string) => void,
): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      const ct = res.headers.get('content-type') ?? ''
      if (!ct.includes('application/json')) {
        throw new Error(`CoinGecko returned non-JSON (${ct}), likely Cloudflare challenge`)
      }
      return res
    }
    if (res.status === 429 && attempt < retries - 1) {
      const retryAfter = res.headers.get('retry-after')
      const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : (attempt + 1) * 15_000
      log?.(`CoinGecko 429, retry ${attempt + 1}/${retries - 1} in ${(wait / 1000).toFixed(0)}s`)
      await sleep(wait)
      continue
    }
    throw new Error(`CoinGecko error: ${res.status}`)
  }
  throw new Error('CoinGecko: exhausted retries')
}

/**
 * Fetch current prices for multiple tokens in a single request.
 * CoinGecko free tier: 10-30 calls/min.
 */
export async function fetchPrices(tokenIds: string[]): Promise<PriceData[]> {
  const ids = tokenIds.join(',')
  const url = `${COINGECKO_BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_7d_change=true`

  const res = await fetchWithRetry(url)

  const data = (await res.json()) as Record<
    string,
    {
      usd: number
      usd_market_cap?: number
      usd_24h_vol?: number
      usd_24h_change?: number
      usd_7d_change?: number
    }
  >

  const now = new Date().toISOString()
  return tokenIds
    .filter((id) => data[id])
    .map((id) => ({
      tokenId: id,
      priceUsd: data[id].usd,
      marketCap: data[id].usd_market_cap ?? null,
      volume24h: data[id].usd_24h_vol ?? null,
      change24h: data[id].usd_24h_change ?? null,
      change7d: data[id].usd_7d_change ?? null,
      capturedAt: now,
    }))
}

/**
 * Fetch historical price data for a single token.
 * CoinGecko free tier: /coins/{id}/market_chart?days=N
 * Returns daily granularity for days > 90, hourly for days > 1, 5-min otherwise.
 */
export async function fetchHistoricalPrices(
  tokenId: string,
  days: number,
  opts?: { retries?: number; log?: (msg: string) => void },
): Promise<HistoricalPricePoint[]> {
  const url = `${COINGECKO_BASE}/coins/${tokenId}/market_chart?vs_currency=usd&days=${days}`

  const res = await fetchWithRetry(url, opts?.retries ?? 3, opts?.log)

  const data = (await res.json()) as {
    prices: [number, number][]
    total_volumes: [number, number][]
    market_caps: [number, number][]
  }

  return data.prices.map(([timestamp, price], i) => ({
    timestamp,
    price,
    volume: data.total_volumes[i]?.[1] ?? null,
    marketCap: data.market_caps[i]?.[1] ?? null,
  }))
}

/**
 * Fetch token metadata (symbol, name) for seeding tracked_tokens.
 * Uses the bulk /coins/list endpoint (1 request) instead of per-token calls.
 */
export async function fetchTokenInfo(
  tokenIds: string[],
): Promise<Array<{ id: string; symbol: string; name: string }>> {
  const res = await fetchWithRetry(`${COINGECKO_BASE}/coins/list`)

  const allCoins = (await res.json()) as Array<{
    id: string
    symbol: string
    name: string
  }>

  const wanted = new Set(tokenIds)
  return allCoins
    .filter((c) => wanted.has(c.id))
    .map((c) => ({
      id: c.id,
      symbol: c.symbol.toUpperCase(),
      name: c.name,
    }))
}
