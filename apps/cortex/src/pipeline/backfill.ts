import type { Kysely } from "kysely";
import { MemoryManager } from "@repo/cairn";
import type { Database } from "../db/schema.js";
import { fetchHistoricalPrices } from "../ingest/prices.js";
import { fetchCryptoPanicHistorical, fetchRSSNews } from "../ingest/news.js";
import { env } from "../env.js";
import { sql } from "kysely";
import {
  getActiveTokens,
  insertPriceSnapshot,
  insertNewsItem,
  getOrCreateConversation,
  saveMessage,
  getStats,
} from "../db/queries.js";
import type { HistoricalPricePoint, NewsData } from "../ingest/types.js";

interface BackfillResult {
  days: number;
  priceSnapshots: number;
  newsItems: number;
  memoriesCreated: number;
  graphNodes: number;
  graphEdges: number;
}

export type BackfillScope = "all" | "news" | "prices";

interface Token {
  id: string;
  symbol: string;
  name: string;
}

type Logger = (msg: string) => void;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NEWS_BATCH_SIZE = 20;

export function formatCompact(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAndStorePrices(
  db: Kysely<Database>,
  tokens: Token[],
  days: number,
  log: Logger,
): Promise<{ priceCount: number; data: Map<string, HistoricalPricePoint[]> }> {
  let priceCount = 0;
  const data = new Map<string, HistoricalPricePoint[]>();

  for (const token of tokens) {
    try {
      log(`Fetching ${days}d price history for ${token.symbol}...`);
      const history = await fetchHistoricalPrices(token.id, days, { retries: 5, log });
      data.set(token.id, history);

      for (const point of history) {
        await insertPriceSnapshot(db, {
          token_id: token.id,
          price_usd: point.price,
          market_cap: point.marketCap,
          volume_24h: point.volume,
          change_24h: null,
          change_7d: null,
          captured_at: new Date(point.timestamp).toISOString().replace("T", " ").replace("Z", ""),
        });
        priceCount++;
      }

      // Rate limit: CoinGecko free tier
      await sleep(2000);
    } catch (err) {
      log(`Price fetch failed for ${token.symbol}, skipping: ${err}`);
    }
  }

  log(`Stored ${priceCount} price snapshots`);
  return { priceCount, data };
}

async function fetchAndStoreNews(
  db: Kysely<Database>,
  days: number,
  log: Logger,
): Promise<{ newsCount: number; allNews: NewsData[] }> {
  const allNews: NewsData[] = [];
  const seenTitles = new Set<string>();

  if (env.CRYPTOPANIC_API_KEY) {
    log("Fetching historical news from CryptoPanic...");
    const pages = Math.min(20, Math.ceil(days / 7));
    try {
      const cpNews = await fetchCryptoPanicHistorical(env.CRYPTOPANIC_API_KEY, pages);
      for (const item of cpNews) {
        seenTitles.add(item.title.toLowerCase());
        allNews.push(item);
      }
    } catch (err) {
      log(`CryptoPanic historical fetch failed: ${err}`);
    }
  }

  log("Fetching news from RSS feeds...");
  try {
    const rssNews = await fetchRSSNews();
    for (const item of rssNews) {
      if (!seenTitles.has(item.title.toLowerCase())) {
        allNews.push(item);
      }
    }
  } catch (err) {
    log(`RSS fetch failed: ${err}`);
  }

  let newsCount = 0;
  for (const item of allNews) {
    const inserted = await insertNewsItem(db, {
      external_id: item.externalId,
      title: item.title,
      url: item.url,
      source: item.source,
      published_at: item.publishedAt,
      tokens_mentioned:
        item.tokensMentioned.length > 0 ? JSON.stringify(item.tokensMentioned) : null,
    });
    if (inserted) newsCount++;
  }

  log(`Stored ${newsCount} news items`);
  return { newsCount, allNews };
}

export function composeWeeklyPriceLines(
  weekStart: number,
  weekEnd: number,
  tokens: Token[],
  allPriceData: Map<string, HistoricalPricePoint[]>,
): string[] {
  const lines: string[] = [];

  for (const token of tokens) {
    const history = allPriceData.get(token.id) ?? [];
    const weekPoints = history.filter((p) => p.timestamp >= weekStart && p.timestamp < weekEnd);
    if (weekPoints.length === 0) continue;

    const first = weekPoints[0]!;
    const last = weekPoints[weekPoints.length - 1]!;
    const change = ((last.price - first.price) / first.price) * 100;
    const high = Math.max(...weekPoints.map((p) => p.price));
    const low = Math.min(...weekPoints.map((p) => p.price));

    lines.push(
      `${token.symbol} weekly: $${first.price.toFixed(2)} → $${last.price.toFixed(2)} (${change >= 0 ? "+" : ""}${change.toFixed(1)}%), range $${low.toFixed(2)}-$${high.toFixed(2)}`,
    );

    for (const point of weekPoints) {
      const date = new Date(point.timestamp).toISOString().slice(0, 10);
      const vol = point.volume != null ? `, vol ${formatCompact(point.volume)}` : "";
      const mcap = point.marketCap != null ? `, mcap ${formatCompact(point.marketCap)}` : "";
      lines.push(`  ${date} ${token.symbol} $${point.price.toFixed(2)}${vol}${mcap}`);
    }
  }

  return lines;
}

async function processPriceWeek(args: {
  db: Kysely<Database>;
  priceConvId: string;
  weekStart: number;
  weekEnd: number;
  weekLabel: string;
  tokens: Token[];
  allPriceData: Map<string, HistoricalPricePoint[]>;
}): Promise<boolean> {
  const { db, priceConvId, weekStart, weekEnd, weekLabel, tokens, allPriceData } = args;

  const existing = await sql<{ cnt: number }>`
    SELECT COUNT(*) as cnt FROM messages
    WHERE conversation_id = ${priceConvId}
      AND content LIKE ${"%Week of " + weekLabel + "%"}
  `.execute(db);

  if (existing.rows[0]?.cnt !== 0) return false;

  const lines = composeWeeklyPriceLines(weekStart, weekEnd, tokens, allPriceData);
  if (lines.length === 0) return false;

  const msg = `[Week of ${weekLabel}] Price data:\n${lines.join("\n")}`;
  await saveMessage(db, { conversation_id: priceConvId, role: "user", content: msg });
  return true;
}

async function processWeeklyPriceBatches(args: {
  db: Kysely<Database>;
  memory: MemoryManager;
  log: Logger;
  priceConvId: string;
  tokens: Token[];
  allPriceData: Map<string, HistoricalPricePoint[]>;
  days: number;
}): Promise<void> {
  const { db, memory, log, priceConvId, tokens, allPriceData, days } = args;
  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;
  const weeks = Math.ceil((endTime - startTime) / WEEK_MS);

  log(`Processing ${weeks} weekly batches through cairn pipeline...`);

  for (let w = 0; w < weeks; w++) {
    const weekStart = startTime + w * WEEK_MS;
    const weekEnd = Math.min(weekStart + WEEK_MS, endTime);
    const weekLabel = new Date(weekStart).toISOString().slice(0, 10);

    const wroteMessages = await processPriceWeek({
      db,
      priceConvId,
      weekStart,
      weekEnd,
      weekLabel,
      tokens,
      allPriceData,
    });

    const isPipelineWeek = (w + 1) % 3 === 0 || w === weeks - 1;
    if (isPipelineWeek) {
      const priceObs = await memory.runObserver(priceConvId);
      if (priceObs) {
        await memory.promoteObservations(priceConvId);
        await memory.runReflector(priceConvId);
      }
      log(`  Week ${w + 1}/${weeks} (${weekLabel}) processed + pipeline run`);
    } else if (wroteMessages) {
      log(`  Week ${w + 1}/${weeks} (${weekLabel}) messages saved`);
    } else {
      log(`  Week ${w + 1}/${weeks} (${weekLabel}) skipped (already processed)`);
    }
  }
}

async function saveNewsBatches(
  db: Kysely<Database>,
  newsConvId: string,
  sortedNews: NewsData[],
): Promise<number> {
  let batchCount = 0;
  for (let i = 0; i < sortedNews.length; i += NEWS_BATCH_SIZE) {
    const batch = sortedNews.slice(i, i + NEWS_BATCH_SIZE);
    const batchNumber = i / NEWS_BATCH_SIZE + 1;
    const firstDate = batch[0]!.publishedAt.slice(0, 10);
    const lastDate = batch[batch.length - 1]!.publishedAt.slice(0, 10);

    const existing = await sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt FROM messages
      WHERE conversation_id = ${newsConvId}
        AND content LIKE ${"%News batch " + batchNumber + "%"}
    `.execute(db);
    if (existing.rows[0]?.cnt && existing.rows[0].cnt > 0) continue;

    const newsLines = batch.map((n) => {
      const date = n.publishedAt.slice(0, 10);
      const toks = n.tokensMentioned.length > 0 ? ` [${n.tokensMentioned.join(", ")}]` : "";
      return `[${date}] ${n.title} (${n.source})${toks}`;
    });

    const msg = `News batch ${batchNumber} (${firstDate} to ${lastDate}, ${batch.length} articles):\n${newsLines.join("\n")}`;
    await saveMessage(db, { conversation_id: newsConvId, role: "user", content: msg });
    batchCount++;
  }
  return batchCount;
}

async function processNewsBatches(
  db: Kysely<Database>,
  memory: MemoryManager,
  log: Logger,
  newsConvId: string,
  allNews: NewsData[],
): Promise<void> {
  if (allNews.length === 0) return;

  const sorted = [...allNews].toSorted(
    (a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime(),
  );

  const batchCount = await saveNewsBatches(db, newsConvId, sorted);
  if (batchCount === 0) return;

  log(`Saved ${batchCount} news batches (${sorted.length} articles) to cairn`);

  // Run pipeline — may need multiple observer passes if lots of news
  let observerRan = true;
  while (observerRan) {
    observerRan = await memory.runObserver(newsConvId);
    if (observerRan) {
      await memory.promoteObservations(newsConvId);
      await memory.runReflector(newsConvId);
    }
  }
}

/**
 * Backfill historical data and run it through the cairn pipeline.
 * Groups data into weekly batches, runs observer/reflector per batch.
 */
export async function runBackfill(
  db: Kysely<Database>,
  memory: MemoryManager,
  days: number,
  log: Logger,
  scope: BackfillScope = "all",
): Promise<BackfillResult> {
  const statsBefore = await getStats(db);
  const tokens = await getActiveTokens(db);
  const skipPrices = scope === "news";
  const skipNews = scope === "prices";

  log(`Starting ${days}-day backfill (${scope}) for ${tokens.length} tokens...`);

  const priceResult = skipPrices
    ? { priceCount: 0, data: new Map<string, HistoricalPricePoint[]>() }
    : await fetchAndStorePrices(db, tokens, days, log);

  const newsResult = skipNews
    ? { newsCount: 0, allNews: [] as NewsData[] }
    : await fetchAndStoreNews(db, days, log);

  const priceConvId = !skipPrices ? await getOrCreateConversation(db, "cortex", "prices") : null;
  const newsConvId = !skipNews ? await getOrCreateConversation(db, "cortex", "news") : null;

  if (priceConvId) {
    await processWeeklyPriceBatches({
      db,
      memory,
      log,
      priceConvId,
      tokens,
      allPriceData: priceResult.data,
      days,
    });
  }

  if (newsConvId) {
    await processNewsBatches(db, memory, log, newsConvId, newsResult.allNews);
  }

  const statsAfter = await getStats(db);

  const result: BackfillResult = {
    days,
    priceSnapshots: priceResult.priceCount,
    newsItems: newsResult.newsCount,
    memoriesCreated: statsAfter.memoryCount - statsBefore.memoryCount,
    graphNodes: statsAfter.nodeCount - statsBefore.nodeCount,
    graphEdges: statsAfter.edgeCount - statsBefore.edgeCount,
  };

  log(
    `Backfill complete: ${result.days} days, ${result.priceSnapshots} prices, ${result.newsItems} news, ` +
      `${result.memoriesCreated} memories, ${result.graphNodes} nodes, ${result.graphEdges} edges`,
  );

  return result;
}
