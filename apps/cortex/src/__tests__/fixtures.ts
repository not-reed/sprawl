/**
 * Factory functions for Cortex test data.
 * Use the spread pattern: createTestX({ field: override })
 */

import type { TrackedToken, PriceSnapshot, NewsItem, Signal, Command } from "../db/schema.js";
import type { PriceData, NewsData } from "../ingest/types.js";

// ── Tracked Tokens ─────────────────────────────────────────────────

export function createTestTrackedToken(overrides: Partial<TrackedToken> = {}): TrackedToken {
  return {
    id: "bitcoin",
    symbol: "BTC",
    name: "Bitcoin",
    active: 1,
    added_at: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

// ── Price Snapshots ────────────────────────────────────────────────

export function createTestPriceSnapshot(overrides: Partial<PriceSnapshot> = {}): PriceSnapshot {
  return {
    id: "ps-test-1",
    token_id: "bitcoin",
    price_usd: 50000,
    market_cap: 1000000000000,
    volume_24h: 25000000000,
    change_24h: 2.5,
    change_7d: 5.0,
    captured_at: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

// ── Signals ────────────────────────────────────────────────────────

export function createTestSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "sig-test-1",
    token_id: "bitcoin",
    signal_type: "buy",
    confidence: 0.7,
    reasoning: "Bullish momentum and strong support levels",
    key_factors: null,
    memory_ids: null,
    timeframe: "short",
    created_at: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

// ── News Items ─────────────────────────────────────────────────────

export function createTestNewsItem(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    id: "news-test-1",
    external_id: "ext-test-1",
    title: "Bitcoin surges past $50k",
    url: "https://example.com/article",
    source: "cryptopanic",
    published_at: "2024-01-15T00:00:00Z",
    tokens_mentioned: '["bitcoin"]',
    ingested_at: "2024-01-15T00:01:00Z",
    memory_id: null,
    ...overrides,
  };
}

// ── Commands ───────────────────────────────────────────────────────

export function createTestCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "cmd-test-1",
    command: "analyze",
    args: null,
    created_at: "2024-01-15T00:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

// ── Ingest types (runtime, not DB) ─────────────────────────────────

export function createTestPriceData(overrides: Partial<PriceData> = {}): PriceData {
  return {
    tokenId: "bitcoin",
    priceUsd: 50000,
    marketCap: 1000000000000,
    volume24h: 25000000000,
    change24h: 2.5,
    change7d: 5.0,
    capturedAt: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

export function createTestNewsData(overrides: Partial<NewsData> = {}): NewsData {
  return {
    externalId: "ext-test-1",
    title: "Bitcoin surges past $50k",
    url: "https://example.com/article",
    source: "cryptopanic",
    publishedAt: "2024-01-15T00:00:00Z",
    tokensMentioned: ["bitcoin"],
    ...overrides,
  };
}
