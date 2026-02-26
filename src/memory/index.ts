/**
 * MemoryManager — single entry point for the memory system.
 * Wraps Graph Memory and Observational Memory behind a clean facade.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { nanoid } from 'nanoid'
import type { Database } from '../db/schema.js'
import type { WorkerModelConfig, Observation } from './types.js'
import { processMemoryForGraph } from './graph/index.js'
import { observe } from './observer.js'
import { reflect } from './reflector.js'
import { renderObservations } from './context.js'
import { estimateTokens, estimateMessageTokens } from './tokens.js'
import { toolLog } from '../logger.js'
import { trackUsage } from '../db/queries.js'

export type { WorkerModelConfig } from './types.js'
export type { ExtractionResult } from './types.js'
export type { Observation } from './types.js'
export { renderObservations } from './context.js'

/** Token thresholds for triggering observer/reflector */
export const OBSERVER_THRESHOLD = 3000
export const REFLECTOR_THRESHOLD = 4000

export class MemoryManager {
  constructor(
    private db: Kysely<Database>,
    private workerConfig: WorkerModelConfig | null,
  ) {}

  // --- Graph Memory ---

  /**
   * Process a newly stored memory for graph extraction.
   * Runs async and non-blocking — fire and forget from the caller's perspective.
   * Tracks usage in ai_usage table.
   */
  async processStoredMemory(memoryId: string, content: string): Promise<void> {
    if (!this.workerConfig) {
      toolLog.debug`Skipping graph extraction: no worker model configured`
      return
    }

    try {
      const result = await processMemoryForGraph(
        this.db,
        this.workerConfig,
        memoryId,
        content,
      )

      if (result.usage) {
        await trackUsage(this.db, {
          model: this.workerConfig.model,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cost_usd: null,
          source: 'graph_extract',
        })
      }
    } catch (err) {
      toolLog.error`Graph extraction failed for memory [${memoryId}]: ${err}`
    }
  }

  // --- Observational Memory ---

  /**
   * Get active (non-superseded) observations for a conversation.
   */
  async getActiveObservations(conversationId: string): Promise<Observation[]> {
    const rows = await this.db
      .selectFrom('observations')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('superseded_at', 'is', null)
      .orderBy('created_at', 'asc')
      .execute()

    return rows.map((r) => ({
      id: r.id,
      conversation_id: r.conversation_id,
      content: r.content,
      priority: r.priority as Observation['priority'],
      observation_date: r.observation_date,
      source_message_ids: r.source_message_ids ? JSON.parse(r.source_message_ids) : [],
      token_count: r.token_count ?? 0,
      generation: r.generation ?? 0,
      superseded_at: r.superseded_at,
      created_at: r.created_at,
    }))
  }

  /**
   * Get messages after the observation watermark (un-observed messages).
   */
  async getUnobservedMessages(
    conversationId: string,
  ): Promise<Array<{ id: string; role: string; content: string; created_at: string; telegram_message_id: number | null }>> {
    // Get the watermark
    const conv = await this.db
      .selectFrom('conversations')
      .select(['observed_up_to_message_id', 'observation_token_count'])
      .where('id', '=', conversationId)
      .executeTakeFirst()

    const watermarkId = conv?.observed_up_to_message_id

    if (watermarkId) {
      // Use rowid comparison to handle messages inserted within the same second.
      // SQLite rowid is monotonically increasing, so this is insertion-order safe.
      const rows = await sql<{ id: string; role: string; content: string; created_at: string; telegram_message_id: number | null }>`
        SELECT id, role, content, created_at, telegram_message_id
        FROM messages
        WHERE conversation_id = ${conversationId}
          AND rowid > (SELECT rowid FROM messages WHERE id = ${watermarkId})
        ORDER BY rowid ASC
      `.execute(this.db)
      return rows.rows
    }

    return this.db
      .selectFrom('messages')
      .select(['id', 'role', 'content', 'created_at', 'telegram_message_id'])
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'asc')
      .execute()
  }

  /**
   * Run the observer to compress un-observed messages into observations.
   * Only runs if un-observed messages exceed the token threshold.
   * Returns true if observations were created.
   */
  async runObserver(conversationId: string): Promise<boolean> {
    if (!this.workerConfig) return false

    const unobserved = await this.getUnobservedMessages(conversationId)
    if (unobserved.length === 0) return false

    const tokenCount = estimateMessageTokens(unobserved)
    if (tokenCount < OBSERVER_THRESHOLD) return false

    toolLog.info`Observer triggered: ${unobserved.length} messages, ~${tokenCount} tokens`

    try {
      const result = await observe(this.workerConfig, {
        messages: unobserved.map((m) => ({
          role: m.role,
          content: m.content,
          created_at: m.created_at,
          telegram_message_id: m.telegram_message_id,
        })),
      })

      if (result.observations.length === 0) return false

      // Store observations
      const messageIds = unobserved.map((m) => m.id)
      const lastMessageId = messageIds[messageIds.length - 1]

      for (const obs of result.observations) {
        const tokenCount = estimateTokens(obs.content)
        await this.db
          .insertInto('observations')
          .values({
            id: nanoid(),
            conversation_id: conversationId,
            content: obs.content,
            priority: obs.priority,
            observation_date: obs.observation_date,
            source_message_ids: JSON.stringify(messageIds),
            token_count: tokenCount,
            generation: 0,
          })
          .execute()
      }

      // Update watermark
      const totalObsTokens = result.observations.reduce(
        (sum, o) => sum + estimateTokens(o.content),
        0,
      )
      const currentTokens = (
        await this.db
          .selectFrom('conversations')
          .select('observation_token_count')
          .where('id', '=', conversationId)
          .executeTakeFirst()
      )?.observation_token_count ?? 0

      await this.db
        .updateTable('conversations')
        .set({
          observed_up_to_message_id: lastMessageId,
          observation_token_count: currentTokens + totalObsTokens,
        })
        .where('id', '=', conversationId)
        .execute()

      toolLog.info`Observer created ${result.observations.length} observations`

      // Track usage
      if (result.usage) {
        await trackUsage(this.db, {
          model: this.workerConfig.model,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cost_usd: null,
          source: 'observer',
        })
      }

      return true
    } catch (err) {
      toolLog.error`Observer failed: ${err}`
      return false
    }
  }

  /**
   * Run the reflector to condense observations when they exceed the threshold.
   * Returns true if observations were condensed.
   */
  async runReflector(conversationId: string): Promise<boolean> {
    if (!this.workerConfig) return false

    const observations = await this.getActiveObservations(conversationId)
    if (observations.length === 0) return false

    const totalTokens = observations.reduce((sum, o) => sum + o.token_count, 0)
    if (totalTokens < REFLECTOR_THRESHOLD) return false

    toolLog.info`Reflector triggered: ${observations.length} observations, ~${totalTokens} tokens`

    try {
      const result = await reflect(this.workerConfig, { observations })

      // Mark superseded observations
      if (result.superseded_ids.length > 0) {
        await this.db
          .updateTable('observations')
          .set({ superseded_at: sql<string>`datetime('now')` })
          .where('id', 'in', result.superseded_ids)
          .execute()
      }

      // Insert new condensed observations
      const maxGen = Math.max(...observations.map((o) => o.generation), 0)
      for (const obs of result.observations) {
        await this.db
          .insertInto('observations')
          .values({
            id: nanoid(),
            conversation_id: conversationId,
            content: obs.content,
            priority: obs.priority,
            observation_date: obs.observation_date,
            source_message_ids: null,
            token_count: estimateTokens(obs.content),
            generation: maxGen + 1,
          })
          .execute()
      }

      // Update observation token count
      const newObservations = await this.getActiveObservations(conversationId)
      const newTokenCount = newObservations.reduce((sum, o) => sum + o.token_count, 0)
      await this.db
        .updateTable('conversations')
        .set({ observation_token_count: newTokenCount })
        .where('id', '=', conversationId)
        .execute()

      toolLog.info`Reflector: ${result.superseded_ids.length} superseded, ${result.observations.length} new`

      // Track usage
      if (result.usage) {
        await trackUsage(this.db, {
          model: this.workerConfig.model,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cost_usd: null,
          source: 'reflector',
        })
      }

      return true
    } catch (err) {
      toolLog.error`Reflector failed: ${err}`
      return false
    }
  }

  /**
   * Build the context for a conversation:
   * 1. Get active observations (stable prefix)
   * 2. Get un-observed messages (active suffix)
   * Returns the observations text and active messages for replay.
   */
  async buildContext(conversationId: string): Promise<{
    observationsText: string
    activeMessages: Array<{
      id: string
      role: string
      content: string
      created_at: string
      telegram_message_id: number | null
    }>
    hasObservations: boolean
  }> {
    const observations = await this.getActiveObservations(conversationId)
    const activeMessages = await this.getUnobservedMessages(conversationId)

    return {
      observationsText: renderObservations(observations),
      activeMessages,
      hasObservations: observations.length > 0,
    }
  }
}
