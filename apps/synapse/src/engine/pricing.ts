import type { CortexReader } from '../cortex/reader.js'

/**
 * Resolve current price for a token from cortex price_snapshots.
 * Returns undefined if no price data exists.
 */
export async function getTokenPrice(
  cortex: CortexReader,
  tokenId: string,
): Promise<number | undefined> {
  const snapshot = await cortex.getTokenPrice(tokenId)
  return snapshot?.price_usd
}

/**
 * Get latest prices for all tokens as a map.
 */
export async function getAllPrices(
  cortex: CortexReader,
): Promise<Map<string, number>> {
  const snapshots = await cortex.getLatestPrices()
  const prices = new Map<string, number>()
  for (const s of snapshots) {
    prices.set(s.token_id, s.price_usd)
  }
  return prices
}
