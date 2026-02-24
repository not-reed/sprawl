import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { nanoid } from 'nanoid'
import { cosineSimilarity } from '../embeddings.js'
import type {
  Database,
  Memory,
  NewMemory,
  NewMessage,
  NewSchedule,
  NewAiUsage,
} from './schema.js'

type DB = Kysely<Database>

// --- Memories ---

export async function storeMemory(
  db: DB,
  memory: Omit<NewMemory, 'id'>,
): Promise<Memory> {
  const id = nanoid()
  await db
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

  return db
    .selectFrom('memories')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

export async function updateMemoryEmbedding(
  db: DB,
  id: string,
  embedding: number[],
): Promise<void> {
  await db
    .updateTable('memories')
    .set({ embedding: JSON.stringify(embedding) })
    .where('id', '=', id)
    .execute()
}

/**
 * Hybrid memory recall: FTS5 → embeddings → LIKE fallback.
 * Results are merged and deduplicated by memory ID.
 */
export async function recallMemories(
  db: DB,
  query: string,
  opts?: {
    category?: string
    limit?: number
    queryEmbedding?: number[]
    similarityThreshold?: number
  },
): Promise<(Memory & { score?: number; matchType?: string })[]> {
  const limit = opts?.limit ?? 10
  const seen = new Set<string>()
  const results: (Memory & { score?: number; matchType?: string })[] = []

  // 1. FTS5 full-text search
  try {
    const ftsQuery = query
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `"${w}"`)
      .join(' OR ')

    if (ftsQuery) {
      let ftsResults = await sql<Memory & { rank: number }>`
        SELECT m.*, fts.rank
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.id
        WHERE memories_fts MATCH ${ftsQuery}
          AND m.archived_at IS NULL
          ${opts?.category ? sql`AND m.category = ${opts.category}` : sql``}
        ORDER BY fts.rank
        LIMIT ${limit}
      `.execute(db)

      for (const row of ftsResults.rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id)
          results.push({ ...row, matchType: 'fts5' })
        }
      }
    }
  } catch {
    // FTS5 table might not exist yet — fall through to LIKE
  }

  // 2. Embedding cosine similarity search
  if (opts?.queryEmbedding && results.length < limit) {
    const threshold = opts.similarityThreshold ?? 0.3
    const allWithEmbeddings = await db
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

  // 3. LIKE fallback if we still have room
  if (results.length < limit) {
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)

    if (keywords.length > 0) {
      let qb = db
        .selectFrom('memories')
        .selectAll()
        .where('archived_at', 'is', null)

      if (opts?.category) {
        qb = qb.where('category', '=', opts.category)
      }

      qb = qb.where((eb) =>
        eb.or(
          keywords.map((kw) =>
            eb.or([
              eb('content', 'like', `%${kw}%`),
              eb('tags', 'like', `%${kw}%`),
            ]),
          ),
        ),
      )

      const likeResults = await qb
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute()

      for (const m of likeResults) {
        if (!seen.has(m.id) && results.length < limit) {
          seen.add(m.id)
          results.push({ ...m, matchType: 'keyword' })
        }
      }
    }
  }

  return results.slice(0, limit)
}

/**
 * Get the N most recent memories (for context injection).
 */
export async function getRecentMemories(
  db: DB,
  limit = 10,
): Promise<Memory[]> {
  return db
    .selectFrom('memories')
    .selectAll()
    .where('archived_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()
}

export async function forgetMemory(
  db: DB,
  id: string,
): Promise<boolean> {
  const result = await db
    .updateTable('memories')
    .set({ archived_at: sql<string>`datetime('now')` })
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .executeTakeFirst()

  return (result.numUpdatedRows ?? 0n) > 0n
}

export async function searchMemoriesForForget(
  db: DB,
  query: string,
): Promise<Memory[]> {
  return recallMemories(db, query, { limit: 5 })
}

// --- Conversations ---

export async function getOrCreateConversation(
  db: DB,
  source: string,
  externalId: string | null,
): Promise<string> {
  if (externalId) {
    const existing = await db
      .selectFrom('conversations')
      .select('id')
      .where('source', '=', source)
      .where('external_id', '=', externalId)
      .executeTakeFirst()

    if (existing) {
      await db
        .updateTable('conversations')
        .set({ updated_at: sql<string>`datetime('now')` })
        .where('id', '=', existing.id)
        .execute()
      return existing.id
    }
  }

  const id = nanoid()
  await db
    .insertInto('conversations')
    .values({ id, source, external_id: externalId })
    .execute()

  return id
}

export async function getRecentMessages(
  db: DB,
  conversationId: string,
  limit = 20,
) {
  return db
    .selectFrom('messages')
    .selectAll()
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()
    .then((msgs) => msgs.reverse())
}

export async function saveMessage(
  db: DB,
  message: Omit<NewMessage, 'id'>,
) {
  const id = nanoid()
  await db
    .insertInto('messages')
    .values({
      id,
      conversation_id: message.conversation_id,
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls ?? null,
    })
    .execute()
  return id
}

// --- Schedules ---

export async function createSchedule(
  db: DB,
  schedule: Omit<NewSchedule, 'id'>,
) {
  const id = nanoid()
  await db
    .insertInto('schedules')
    .values({
      id,
      description: schedule.description,
      cron_expression: schedule.cron_expression ?? null,
      run_at: schedule.run_at ?? null,
      message: schedule.message,
      chat_id: schedule.chat_id,
      last_run_at: null,
    })
    .execute()

  return db
    .selectFrom('schedules')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

export async function listSchedules(db: DB, activeOnly = true) {
  let qb = db.selectFrom('schedules').selectAll()
  if (activeOnly) {
    qb = qb.where('active', '=', 1)
  }
  return qb.orderBy('created_at', 'desc').execute()
}

export async function cancelSchedule(db: DB, id: string) {
  const result = await db
    .updateTable('schedules')
    .set({ active: 0 })
    .where('id', '=', id)
    .where('active', '=', 1)
    .executeTakeFirst()

  return (result.numUpdatedRows ?? 0n) > 0n
}

export async function markScheduleRun(db: DB, id: string) {
  await db
    .updateTable('schedules')
    .set({ last_run_at: sql<string>`datetime('now')` })
    .where('id', '=', id)
    .execute()
}

// --- AI Usage ---

export async function trackUsage(
  db: DB,
  usage: Omit<NewAiUsage, 'id'>,
) {
  await db
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

// --- Settings ---

export async function getSetting(db: DB, key: string) {
  const row = await db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst()

  return row?.value ?? null
}

export async function setSetting(db: DB, key: string, value: string) {
  const now = new Date().toISOString()
  await db
    .insertInto('settings')
    .values({ key, value, updated_at: now })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({ value, updated_at: now }),
    )
    .execute()
}
