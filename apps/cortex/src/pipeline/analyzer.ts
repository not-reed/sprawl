import type { Kysely } from "kysely";
import {
  recallMemories,
  generateEmbedding,
  searchNodesWithScores,
  spreadActivation,
  getRelatedMemoriesWithScores,
  storeMemory,
  type MemoryManager,
} from "@repo/cairn";
import type { Database } from "../db/schema.js";
import { env } from "../env.js";
import { AnalyzerError } from "../errors.js";
import { getActiveTokens, getLatestPrices, insertSignal } from "../db/queries.js";
import { SHORT_SIGNAL_PROMPT, LONG_SIGNAL_PROMPT } from "./prompts.js";

interface SignalResult {
  signal: "buy" | "sell" | "hold";
  confidence: number;
  reasoning: string;
  key_factors: string[];
}

/**
 * Generate buy/sell/hold signals for every active tracked token.
 * Runs both short-term (24h) and long-term (4w) analysis per token using
 * hybrid memory recall + graph context for LLM prompting.
 * Stores results in the signals table and as cairn memories (feedback loop).
 */
export async function analyzeAllTokens(
  db: Kysely<Database>,
  memory: MemoryManager,
  log: (msg: string) => void,
): Promise<void> {
  const tokens = await getActiveTokens(db);
  const prices = await getLatestPrices(db);
  const priceMap = new Map(prices.map((p) => [p.token_id, p]));

  for (const token of tokens) {
    const price = priceMap.get(token.id);
    if (!price) {
      log(`Skipping ${token.symbol}: no price data`);
      continue;
    }

    for (const timeframe of ["short", "long"] as const) {
      try {
        const result = await analyzeToken(db, token, price, timeframe, log, memory);
        if (result) {
          const label = timeframe === "short" ? "24h" : "4w";
          log(
            `Signal: ${token.symbol} [${label}] ${result.signal.toUpperCase()} (${result.confidence.toFixed(2)}) — ${result.reasoning.slice(0, 80)}`,
          );
        }
      } catch (err) {
        log(`Analysis failed for ${token.symbol} [${timeframe}]: ${err}`);
      }
    }
  }
}

async function analyzeToken(
  db: Kysely<Database>,
  token: { id: string; symbol: string; name: string },
  price: {
    price_usd: number;
    change_24h: number | null;
    change_7d: number | null;
    volume_24h: number | null;
  },
  timeframe: "short" | "long",
  log: (msg: string) => void,
  memory?: MemoryManager,
): Promise<SignalResult | null> {
  // 1. Recall relevant memories via hybrid search
  const queryText = await generateRecallQuery(token, price, timeframe);
  let queryEmbedding: number[] | undefined;
  try {
    queryEmbedding = await generateEmbedding(
      env.OPENROUTER_API_KEY,
      queryText,
      env.EMBEDDING_MODEL,
    );
  } catch {
    // Fall through without embedding
  }

  const memories = await recallMemories(db, queryText, {
    limit: 15,
    queryEmbedding,
  });

  // 2. Graph context: find nodes related to this token via spreading activation
  let graphContext = "";
  try {
    const seedNodes = await searchNodesWithScores(db, token.name, 5, queryEmbedding);
    if (seedNodes.length > 0) {
      const seeds = seedNodes.map((s) => ({ nodeId: s.node.id, score: s.score }));
      const activated = await spreadActivation(db, seeds, { maxDepth: 2 });

      const graphLines = activated.map(
        (t) =>
          `${t.node.display_name} (${t.node.node_type}) [score ${t.score.toFixed(2)}, depth ${t.depth}]`,
      );
      graphContext = graphLines.join("\n");

      // Get scored memories linked to graph nodes
      const nodeScoreMap = new Map<string, number>();
      for (const s of seedNodes) nodeScoreMap.set(s.node.id, s.score);
      for (const a of activated) nodeScoreMap.set(a.node.id, a.score);

      const scoredMems = await getRelatedMemoriesWithScores(db, nodeScoreMap);
      const memIds = scoredMems
        .filter((s) => !memories.some((m) => m.id === s.memoryId))
        .slice(0, 5)
        .map((s) => s.memoryId);

      if (memIds.length > 0) {
        const graphMemories = await Promise.all(
          memIds.map((id) =>
            db.selectFrom("memories").selectAll().where("id", "=", id).executeTakeFirst(),
          ),
        );
        for (const m of graphMemories) {
          if (m) memories.push(m);
        }
      }
    }
  } catch {
    // Graph context is optional
  }

  // 3. Note memory depth for context injection (no longer caps confidence)
  const memoryDepth = memories.length < 5 ? "low" : memories.length < 20 ? "moderate" : "high";

  // 4. Compose prompt
  const memoriesText = memories.map((m, i) => `${i + 1}. [${m.category}] ${m.content}`).join("\n");

  const basePrompt = timeframe === "short" ? SHORT_SIGNAL_PROMPT : LONG_SIGNAL_PROMPT;
  const prompt = basePrompt
    .replace(
      "{context}",
      `${memories.length} memories (${memoryDepth} depth), graph data available`,
    )
    .replace("{token_symbol}", token.symbol)
    .replace("{token_name}", token.name)
    .replace("{current_price}", `$${price.price_usd.toFixed(2)}`)
    .replace("{change_24h}", price.change_24h != null ? `${price.change_24h.toFixed(1)}%` : "N/A")
    .replace("{change_7d}", price.change_7d != null ? `${price.change_7d.toFixed(1)}%` : "N/A")
    .replace(
      "{volume_24h}",
      price.volume_24h != null ? `$${(price.volume_24h / 1e9).toFixed(1)}B` : "N/A",
    )
    .replace("{memory_count}", String(memories.length))
    .replace("{memories}", memoriesText || "No memories yet.")
    .replace("{graph_context}", graphContext || "No graph connections yet.");

  // 5. Call LLM (slightly higher temp for long-term to encourage divergence)
  const response = await callLLM(prompt, timeframe === "long" ? 0.5 : 0.3);
  if (!response) return null;

  // 6. Parse response
  let parsed: SignalResult;
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new AnalyzerError("No JSON in response");
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    log(`Failed to parse signal response for ${token.symbol}`);
    return null;
  }

  // Validate
  if (!["buy", "sell", "hold"].includes(parsed.signal)) parsed.signal = "hold";
  parsed.confidence = Math.max(0, Math.min(1, parsed.confidence));

  // 7. Store signal
  const memoryIds = memories.map((m) => m.id);
  await insertSignal(db, {
    token_id: token.id,
    signal_type: parsed.signal,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    key_factors: JSON.stringify(parsed.key_factors ?? []),
    memory_ids: JSON.stringify(memoryIds),
    timeframe,
  });

  // 8. Store signal reasoning as a cairn memory with embedding + graph extraction
  const signalContent = `[Signal ${token.symbol} ${timeframe}] ${parsed.signal.toUpperCase()} (${parsed.confidence.toFixed(2)}): ${parsed.reasoning}`;
  let signalEmbedding: string | null = null;
  try {
    const embedding = await generateEmbedding(
      env.OPENROUTER_API_KEY,
      signalContent,
      env.EMBEDDING_MODEL,
    );
    signalEmbedding = JSON.stringify(embedding);
  } catch {
    // Proceed without embedding
  }

  const signalMemory = await storeMemory(db, {
    content: signalContent,
    category: "signal",
    source: "analyzer",
    tags: JSON.stringify([token.symbol, parsed.signal]),
    embedding: signalEmbedding,
  });

  // Fire graph extraction async so signal entities (tokens, events) get indexed
  if (memory) {
    memory.processStoredMemory(signalMemory.id, signalMemory.content).catch(() => {});
  }

  return parsed;
}

const analyzerModel = env.ANALYZER_MODEL ?? env.MEMORY_WORKER_MODEL;

async function callLLM(
  prompt: string,
  temperature = 0.3,
  opts?: { model?: string; maxTokens?: number },
): Promise<string | null> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: opts?.model ?? analyzerModel,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: opts?.maxTokens ?? 500,
      reasoning: { max_tokens: 1 },
    }),
  });

  if (!response.ok) {
    throw new AnalyzerError(`LLM error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices[0]?.message?.content ?? null;
}

/**
 * Generate a targeted recall query via LLM instead of static strings.
 * Falls back to static query on failure.
 */
async function generateRecallQuery(
  token: { name: string; symbol: string },
  price: { price_usd: number; change_24h: number | null; change_7d: number | null },
  timeframe: "short" | "long",
): Promise<string> {
  const staticFallback =
    timeframe === "short"
      ? `${token.name} ${token.symbol} price momentum news catalyst volume today`
      : `${token.name} ${token.symbol} macro trend fundamentals regulation narrative outlook`;

  try {
    const change24h = price.change_24h != null ? `${price.change_24h.toFixed(1)}%` : "N/A";
    const change7d = price.change_7d != null ? `${price.change_7d.toFixed(1)}%` : "N/A";
    const tfLabel = timeframe === "short" ? "24-hour" : "4-week";

    const prompt = `Generate a memory search query for ${tfLabel} analysis of ${token.name} (${token.symbol}). Given: price $${price.price_usd.toFixed(2)}, 24h ${change24h}, 7d ${change7d}. Return only the search query, no explanation.`;

    const result = await callLLM(prompt, 0, { maxTokens: 100 });
    if (!result?.trim()) return staticFallback;

    return result.trim();
  } catch {
    return staticFallback;
  }
}
