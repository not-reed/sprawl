import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { nanoid } from 'nanoid'
import type {
  Database,
  NewSchedule,
} from './schema.js'

type DB = Kysely<Database>

// Re-export cairn query functions that construct code needs
export { storeMemory, recallMemories, getRecentMemories, forgetMemory, searchMemoriesForForget, trackUsage, updateMemoryEmbedding } from '@repo/cairn'

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
  message: { conversation_id: string; role: string; content: string; tool_calls?: string | null; telegram_message_id?: number | null },
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
      telegram_message_id: message.telegram_message_id ?? null,
    })
    .execute()
  return id
}

export async function updateTelegramMessageId(
  db: DB,
  internalId: string,
  telegramMsgId: number,
) {
  await db
    .updateTable('messages')
    .set({ telegram_message_id: telegramMsgId })
    .where('id', '=', internalId)
    .execute()
}

export async function getMessageByTelegramId(
  db: DB,
  conversationId: string,
  telegramMsgId: number,
) {
  return db
    .selectFrom('messages')
    .selectAll()
    .where('conversation_id', '=', conversationId)
    .where('telegram_message_id', '=', telegramMsgId)
    .executeTakeFirst()
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
      prompt: schedule.prompt ?? null,
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

export interface UsageStats {
  total_cost: number
  total_input_tokens: number
  total_output_tokens: number
  message_count: number
  daily: { date: string; cost: number; messages: number }[]
}

export async function getUsageStats(
  db: DB,
  opts?: { days?: number; source?: string },
): Promise<UsageStats> {
  const days = opts?.days ?? 30
  const cutoff = sql<string>`datetime('now', ${`-${days} days`})`

  let totalsQuery = db
    .selectFrom('ai_usage')
    .select([
      sql<number>`coalesce(sum(cost_usd), 0)`.as('total_cost'),
      sql<number>`coalesce(sum(input_tokens), 0)`.as('total_input_tokens'),
      sql<number>`coalesce(sum(output_tokens), 0)`.as('total_output_tokens'),
      sql<number>`count(*)`.as('message_count'),
    ])
    .where('created_at', '>=', cutoff)

  let dailyQuery = db
    .selectFrom('ai_usage')
    .select([
      sql<string>`date(created_at)`.as('date'),
      sql<number>`coalesce(sum(cost_usd), 0)`.as('cost'),
      sql<number>`count(*)`.as('messages'),
    ])
    .where('created_at', '>=', cutoff)
    .groupBy(sql`date(created_at)`)
    .orderBy(sql`date(created_at)`, 'desc')

  if (opts?.source) {
    totalsQuery = totalsQuery.where('source', '=', opts.source)
    dailyQuery = dailyQuery.where('source', '=', opts.source)
  }

  const [totals, daily] = await Promise.all([
    totalsQuery.executeTakeFirstOrThrow(),
    dailyQuery.execute(),
  ])

  return {
    total_cost: Number(totals.total_cost),
    total_input_tokens: Number(totals.total_input_tokens),
    total_output_tokens: Number(totals.total_output_tokens),
    message_count: Number(totals.message_count),
    daily: daily.map((d) => ({
      date: d.date,
      cost: Number(d.cost),
      messages: Number(d.messages),
    })),
  }
}

// --- Pending Asks ---

export async function createPendingAsk(
  db: DB,
  ask: { id: string; conversationId: string; chatId: string; question: string; options?: string[] },
) {
  // Auto-resolve any existing pending ask for this chat
  await db
    .updateTable('pending_asks')
    .set({ resolved_at: sql<string>`datetime('now')`, response: '[superseded]' })
    .where('chat_id', '=', ask.chatId)
    .where('resolved_at', 'is', null)
    .execute()

  await db
    .insertInto('pending_asks')
    .values({
      id: ask.id,
      conversation_id: ask.conversationId,
      chat_id: ask.chatId,
      question: ask.question,
      options: ask.options ? JSON.stringify(ask.options) : null,
    })
    .execute()
}

export async function getPendingAsk(db: DB, chatId: string) {
  return db
    .selectFrom('pending_asks')
    .selectAll()
    .where('chat_id', '=', chatId)
    .where('resolved_at', 'is', null)
    .where('created_at', '>=', sql<string>`datetime('now', '-10 minutes')`)
    .executeTakeFirst()
}

export async function getPendingAskById(db: DB, askId: string) {
  return db
    .selectFrom('pending_asks')
    .selectAll()
    .where('id', '=', askId)
    .executeTakeFirst()
}

export async function resolvePendingAsk(db: DB, askId: string, response: string) {
  await db
    .updateTable('pending_asks')
    .set({ resolved_at: sql<string>`datetime('now')`, response })
    .where('id', '=', askId)
    .execute()
}

export async function setPendingAskTelegramId(db: DB, askId: string, msgId: number) {
  await db
    .updateTable('pending_asks')
    .set({ telegram_message_id: msgId })
    .where('id', '=', askId)
    .execute()
}

/**
 * Get the most recent resolved ask for a chat (within last 5 minutes).
 * Used by self-edit tools to check if user rejected a recent proposal.
 */
export async function getLastResolvedAsk(db: DB, chatId: string) {
  return db
    .selectFrom('pending_asks')
    .selectAll()
    .where('chat_id', '=', chatId)
    .where('resolved_at', 'is not', null)
    .where('resolved_at', '>=', sql<string>`datetime('now', '-5 minutes')`)
    .orderBy('resolved_at', 'desc')
    .executeTakeFirst()
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
