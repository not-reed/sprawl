export interface PriceData {
  tokenId: string;
  priceUsd: number;
  marketCap: number | null;
  volume24h: number | null;
  change24h: number | null;
  change7d: number | null;
  capturedAt: string; // ISO datetime
}

export interface NewsData {
  externalId: string;
  title: string;
  url: string | null;
  source: string;
  publishedAt: string; // ISO datetime
  tokensMentioned: string[];
}

export interface HistoricalPricePoint {
  timestamp: number; // unix ms
  price: number;
  volume: number | null;
  marketCap: number | null;
}
