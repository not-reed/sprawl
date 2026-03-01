import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { nanoid } from 'nanoid'
import { cosineSimilarity } from '../embeddings.js'
import type { CairnDatabase, Memory, NewMemory, NewAiUsage } from './types.js'

// Kysely is invariant in its type parameter: Kysely<A> is not assignable to
// Kysely<B> even when A extends B. To allow consumers with their own extended
// database interfaces (e.g. `interface Database extends CairnDatabase { ... }`)
// to call cairn functions, we accept `Kysely<any>` at the boundary and cast
// to the properly-typed `Kysely<CairnDatabase>` internally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDB = Kysely<any>
type DB = Kysely<CairnDatabase>
const typed = (db: AnyDB): DB => db as DB

// --- Memories ---

export async function storeMemory(
  db: AnyDB,
  memory: Omit<NewMemory, 'id'>,
): Promise<Memory> {
  const d = typed(db)
  const id = nanoid()
  await d
    .insertInto('memories')
    .values({
      id,
      content: memory.content,
      category: memory.category ?? 'general',
      tags: memory.tags ?? null,
      source: memory.source ?? 'user',
      embedding: memory.embedding ?? null,
      archived_at: null,
    })
    .execute()

  return d
    .selectFrom('memories')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

export async function updateMemoryEmbedding(
  db: AnyDB,
  id: string,
  embedding: number[],
): Promise<void> {
  await typed(db)
    .updateTable('memories')
    .set({ embedding: JSON.stringify(embedding) })
    .where('id', '=', id)
    .execute()
}

/**
 * Hybrid memory recall: FTS5 + embeddings.
 * Results are merged and deduplicated by memory ID.
 */
export async function recallMemories(
  db: AnyDB,
  query: string,
  opts?: {
    category?: string
    limit?: number
    queryEmbedding?: number[]
    similarityThreshold?: number
  },
): Promise<(Memory & { score?: number; matchType?: string })[]> {
  const d = typed(db)
  const limit = opts?.limit ?? 10
  const seen = new Set<string>()
  const results: (Memory & { score?: number; matchType?: string })[] = []

  // 1. FTS5 full-text search
  try {
    const ftsQuery = query
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `"${w.replace(/"/g, '')}"`)
      .filter((w) => w !== '""')
      .join(' OR ')

    if (ftsQuery) {
      const ftsResults = await sql<Memory & { rank: number }>`
        SELECT m.*, fts.rank
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.id
        WHERE memories_fts MATCH ${ftsQuery}
          AND m.archived_at IS NULL
          ${opts?.category ? sql`AND m.category = ${opts.category}` : sql``}
        ORDER BY fts.rank
        LIMIT ${limit}
      `.execute(d)

      for (const row of ftsResults.rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id)
          results.push({ ...row, matchType: 'fts5' })
        }
      }
    }
  } catch {
    // FTS5 table might not exist yet — fall through to embeddings
  }

  // 2. Embedding cosine similarity search
  if (opts?.queryEmbedding && results.length < limit) {
    const threshold = opts.similarityThreshold ?? 0.3
    const allWithEmbeddings = await d
      .selectFrom('memories')
      .selectAll()
      .where('archived_at', 'is', null)
      .where('embedding', 'is not', null)
      .$if(!!opts.category, (qb) => qb.where('category', '=', opts!.category!))
      .execute()

    const scored = allWithEmbeddings
      .map((m) => ({
        ...m,
        score: cosineSimilarity(opts.queryEmbedding!, JSON.parse(m.embedding!)),
        matchType: 'embedding' as const,
      }))
      .filter((m) => m.score >= threshold)
      .sort((a, b) => b.score - a.score)

    for (const m of scored) {
      if (!seen.has(m.id) && results.length < limit) {
        seen.add(m.id)
        results.push(m)
      }
    }
  }

  return results.slice(0, limit)
}

/**
 * Get the N most recent memories (for context injection).
 */
export async function getRecentMemories(
  db: AnyDB,
  limit = 10,
): Promise<Memory[]> {
  return typed(db)
    .selectFrom('memories')
    .selectAll()
    .where('archived_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()
}

export async function forgetMemory(
  db: AnyDB,
  id: string,
): Promise<boolean> {
  const result = await typed(db)
    .updateTable('memories')
    .set({ archived_at: sql<string>`datetime('now')` })
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .executeTakeFirst()

  return (result.numUpdatedRows ?? 0n) > 0n
}

export async function searchMemoriesForForget(
  db: AnyDB,
  query: string,
): Promise<Memory[]> {
  return recallMemories(db, query, { limit: 5 })
}

// --- AI Usage ---

export async function trackUsage(
  db: AnyDB,
  usage: Omit<NewAiUsage, 'id'>,
) {
  await typed(db)
    .insertInto('ai_usage')
    .values({
      id: nanoid(),
      model: usage.model,
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      cost_usd: usage.cost_usd ?? null,
      source: usage.source,
    })
    .execute()
}
