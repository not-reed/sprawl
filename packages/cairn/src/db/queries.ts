import type { Kysely } from "kysely";
import { sql } from "kysely";
import { nanoid } from "nanoid";
import { cosineSimilarity } from "../embeddings.js";
import { SIMILARITY } from "../similarity.js";
import type { CairnDatabase, Memory, NewMemory, NewAiUsage } from "./types.js";

// Kysely is invariant in its type parameter: Kysely<A> is not assignable to
// Kysely<B> even when A extends B. To allow consumers with their own extended
// database interfaces (e.g. `interface Database extends CairnDatabase { ... }`)
// to call cairn functions, we accept `Kysely<any>` at the boundary and cast
// to the properly-typed `Kysely<CairnDatabase>` internally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDB = Kysely<any>;
type DB = Kysely<CairnDatabase>;
const typed = (db: AnyDB): DB => db as DB;

// --- Memories ---

/**
 * Insert a new memory and return the full row.
 * Generates a nanoid for the ID. Defaults category to 'general', source to 'user'.
 */
export async function storeMemory(db: AnyDB, memory: Omit<NewMemory, "id">): Promise<Memory> {
  const d = typed(db);
  const id = nanoid();
  await d
    .insertInto("memories")
    .values({
      id,
      content: memory.content,
      category: memory.category ?? "general",
      tags: memory.tags ?? null,
      source: memory.source ?? "user",
      embedding: memory.embedding ?? null,
      archived_at: null,
    })
    .execute();

  return d.selectFrom("memories").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

/** Overwrite a memory's embedding vector (JSON-serialized). */
export async function updateMemoryEmbedding(
  db: AnyDB,
  id: string,
  embedding: number[],
): Promise<void> {
  await typed(db)
    .updateTable("memories")
    .set({ embedding: JSON.stringify(embedding) })
    .where("id", "=", id)
    .execute();
}

/**
 * Hybrid memory recall: FTS5 full-text search + embedding cosine similarity.
 * Results from both sources are merged, deduplicated by memory ID, and
 * scored with recency decay (full weight for 7 days, logarithmic after).
 * @param db - Database handle.
 * @param query - Free-text search query (tokenized for FTS5, also used for embedding lookup).
 * @param opts.category - Filter to a specific memory category.
 * @param opts.limit - Max results (default 10).
 * @param opts.queryEmbedding - Pre-computed embedding for similarity search. Omit to skip embedding search.
 * @param opts.similarityThreshold - Min cosine similarity for embedding matches (default RECALL_DEFAULT).
 */
export async function recallMemories(
  db: AnyDB,
  query: string,
  opts?: {
    category?: string;
    limit?: number;
    queryEmbedding?: number[];
    similarityThreshold?: number;
  },
): Promise<(Memory & { score?: number; matchType?: string })[]> {
  const d = typed(db);
  const limit = opts?.limit ?? 10;
  const seen = new Set<string>();
  const results: (Memory & { score?: number; matchType?: string })[] = [];

  // 1. FTS5 full-text search
  try {
    const ftsQuery = query
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `"${w.replace(/"/g, "")}"`)
      .filter((w) => w !== '""')
      .join(" OR ");

    if (ftsQuery) {
      const ftsResults = await sql<Memory & { rank: number }>`
        SELECT m.*, fts.rank
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.id
        WHERE memories_fts MATCH ${ftsQuery}
          AND m.archived_at IS NULL
          ${opts?.category ? sql`AND m.category = ${opts.category}` : sql``}
        ORDER BY fts.rank
        LIMIT ${limit * 2}
      `.execute(d);

      const scoredFts = ftsResults.rows.map((row) => {
        const ageInDays = (Date.now() - new Date(row.created_at).getTime()) / 86_400_000;
        // FTS5 rank is negative (more negative = more relevant). Convert to positive relevance.
        const relevance = Math.abs(row.rank);
        const decay = ageInDays <= 7 ? 1.0 : 1.0 / (1.0 + Math.log2(ageInDays / 7));
        return { ...row, score: relevance * decay, matchType: "fts5" as const };
      });

      scoredFts.sort((a, b) => b.score - a.score);

      for (const row of scoredFts.slice(0, limit)) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          results.push(row);
        }
      }
    }
  } catch {
    // FTS5 table might not exist yet — fall through to embeddings
  }

  // 2. Embedding cosine similarity search
  if (opts?.queryEmbedding && results.length < limit) {
    const threshold = opts.similarityThreshold ?? SIMILARITY.RECALL_DEFAULT;
    const allWithEmbeddings = await d
      .selectFrom("memories")
      .selectAll()
      .where("archived_at", "is", null)
      .where("embedding", "is not", null)
      .$if(!!opts.category, (qb) => qb.where("category", "=", opts!.category!))
      .execute();

    const scored = allWithEmbeddings
      .map((m) => {
        const rawScore = cosineSimilarity(opts.queryEmbedding!, JSON.parse(m.embedding!));
        // Recency decay: full weight for first 7 days, then logarithmic decay
        const ageInDays = (Date.now() - new Date(m.created_at).getTime()) / 86_400_000;
        const decay = ageInDays <= 7 ? 1.0 : 1.0 / (1.0 + Math.log2(ageInDays / 7));
        return {
          ...m,
          score: rawScore * decay,
          matchType: "embedding" as const,
        };
      })
      .filter((m) => m.score >= threshold)
      .toSorted((a, b) => b.score - a.score);

    for (const m of scored) {
      if (!seen.has(m.id) && results.length < limit) {
        seen.add(m.id);
        results.push(m);
      }
    }
  }

  return results.slice(0, limit);
}

/**
 * Get the N most recent memories (for context injection).
 */
export async function getRecentMemories(db: AnyDB, limit = 10): Promise<Memory[]> {
  return typed(db)
    .selectFrom("memories")
    .selectAll()
    .where("archived_at", "is", null)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}

/** Soft-delete a memory by setting archived_at. Returns true if a row was updated. */
export async function forgetMemory(db: AnyDB, id: string): Promise<boolean> {
  const result = await typed(db)
    .updateTable("memories")
    .set({ archived_at: sql<string>`datetime('now')` })
    .where("id", "=", id)
    .where("archived_at", "is", null)
    .executeTakeFirst();

  return (result.numUpdatedRows ?? 0n) > 0n;
}

/** Search memories by text query, returning top 5 candidates for deletion. */
export async function searchMemoriesForForget(db: AnyDB, query: string): Promise<Memory[]> {
  return recallMemories(db, query, { limit: 5 });
}

// --- AI Usage ---

/** Record an LLM API call in the ai_usage table for cost/token tracking. */
export async function trackUsage(db: AnyDB, usage: Omit<NewAiUsage, "id">) {
  await typed(db)
    .insertInto("ai_usage")
    .values({
      id: nanoid(),
      model: usage.model,
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      cost_usd: usage.cost_usd ?? null,
      source: usage.source,
    })
    .execute();
}
