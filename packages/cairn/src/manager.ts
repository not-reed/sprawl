/**
 * MemoryManager — single entry point for the Cairn memory system.
 * Wraps Graph Memory and Observational Memory behind a clean facade.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { nanoid } from "nanoid";
import type {
  WorkerModelConfig,
  Observation,
  ObserverOutput,
  CairnLogger,
  CairnMessage,
} from "./types.js";
import { nullLogger } from "./types.js";
import { processMemoryForGraph } from "./graph/index.js";
import { observe } from "./observer.js";
import { reflect } from "./reflector.js";
import { renderObservations, renderObservationsWithBudget, OBSERVATION_BUDGET } from "./context.js";
import { estimateTokens, estimateMessageTokens } from "./tokens.js";
import { storeMemory, trackUsage } from "./db/queries.js";
import { generateEmbeddings, cosineSimilarity } from "./embeddings.js";

/** Token thresholds for triggering observer/reflector */
export const OBSERVER_THRESHOLD = 3000;
export const REFLECTOR_THRESHOLD = 4000;

/** Max tokens per observer batch — prevents the worker model from choking on huge payloads */
export const OBSERVER_MAX_BATCH_TOKENS = 16_000;

export interface CairnOptions {
  workerConfig: WorkerModelConfig | null;
  embeddingModel?: string;
  apiKey: string;
  logger?: CairnLogger;
  observerPrompt?: string;
  reflectorPrompt?: string;
  entityTypes?: string[];
}

export class MemoryManager {
  protected db: Kysely<any>;
  private workerConfig: WorkerModelConfig | null;
  private embeddingModel?: string;
  private apiKey: string;
  protected log: CairnLogger;
  private observerPrompt?: string;
  private reflectorPrompt?: string;
  private entityTypes?: string[];

  constructor(db: Kysely<any>, opts: CairnOptions) {
    this.db = db;
    this.workerConfig = opts.workerConfig;
    this.embeddingModel = opts.embeddingModel;
    this.apiKey = opts.apiKey;
    this.log = opts.logger ?? nullLogger;
    this.observerPrompt = opts.observerPrompt;
    this.reflectorPrompt = opts.reflectorPrompt;
    this.entityTypes = opts.entityTypes;
  }

  // --- Observation Storage Hook (override in subclasses to add custom fields) ---

  protected async storeObservation(
    conversationId: string,
    obs: ObserverOutput["observations"][0],
    messageIds: string[] | null,
    generation: number,
  ): Promise<void> {
    await this.db
      .insertInto("observations")
      .values({
        id: nanoid(),
        conversation_id: conversationId,
        content: obs.content,
        priority: obs.priority,
        observation_date: obs.observation_date,
        source_message_ids: messageIds ? JSON.stringify(messageIds) : null,
        token_count: estimateTokens(obs.content),
        generation,
      })
      .execute();
  }

  // --- Graph Memory ---

  /**
   * Process a newly stored memory for graph extraction.
   * Runs async and non-blocking — fire and forget from the caller's perspective.
   * Tracks usage in ai_usage table.
   */
  async processStoredMemory(memoryId: string, content: string): Promise<void> {
    if (!this.workerConfig) {
      this.log.debug("Skipping graph extraction: no worker model configured");
      return;
    }

    try {
      const result = await processMemoryForGraph(
        this.db,
        this.workerConfig,
        memoryId,
        content,
        { apiKey: this.apiKey, embeddingModel: this.embeddingModel },
        this.log,
        this.entityTypes,
      );

      if (result.usage) {
        await trackUsage(this.db, {
          model: this.workerConfig.model,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cost_usd: null,
          source: "graph_extract",
        });
      }
    } catch (err) {
      this.log.error(`Graph extraction failed for memory [${memoryId}]: ${err}`);
    }
  }

  // --- Batching ---

  /**
   * Split messages into batches that each fit under the token ceiling.
   * Messages are never split mid-message — a single message that exceeds
   * the ceiling gets its own batch.
   */
  batchMessages(messages: CairnMessage[], maxTokens: number): CairnMessage[][] {
    const batches: (typeof messages)[] = [];
    let current: typeof messages = [];
    let currentTokens = 0;

    for (const msg of messages) {
      const msgTokens = 4 + estimateTokens(msg.content);

      if (current.length > 0 && currentTokens + msgTokens > maxTokens) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }

      current.push(msg);
      currentTokens += msgTokens;
    }

    if (current.length > 0) {
      batches.push(current);
    }

    return batches;
  }

  // --- Observational Memory ---

  /**
   * Get active (non-superseded) observations for a conversation.
   */
  async getActiveObservations(conversationId: string): Promise<Observation[]> {
    const rows = await this.db
      .selectFrom("observations")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .where("superseded_at", "is", null)
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((r) => ({
      id: r.id,
      conversation_id: r.conversation_id,
      content: r.content,
      priority: r.priority as Observation["priority"],
      observation_date: r.observation_date,
      source_message_ids: r.source_message_ids ? JSON.parse(r.source_message_ids) : [],
      token_count: r.token_count ?? 0,
      generation: r.generation ?? 0,
      superseded_at: r.superseded_at,
      created_at: r.created_at,
    }));
  }

  /**
   * Get messages after the observation watermark (un-observed messages).
   */
  async getUnobservedMessages(conversationId: string): Promise<CairnMessage[]> {
    // Get the watermark
    const conv = await this.db
      .selectFrom("conversations")
      .select(["observed_up_to_message_id", "observation_token_count"])
      .where("id", "=", conversationId)
      .executeTakeFirst();

    const watermarkId = conv?.observed_up_to_message_id;

    if (watermarkId) {
      // Use rowid comparison to handle messages inserted within the same second.
      // SQLite rowid is monotonically increasing, so this is insertion-order safe.
      const rows = await sql<CairnMessage>`
        SELECT id, conversation_id, role, content, created_at
        FROM messages
        WHERE conversation_id = ${conversationId}
          AND rowid > (SELECT rowid FROM messages WHERE id = ${watermarkId})
        ORDER BY rowid ASC
      `.execute(this.db);
      return rows.rows;
    }

    return this.db
      .selectFrom("messages")
      .select(["id", "role", "content", "created_at"])
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "asc")
      .execute() as Promise<CairnMessage[]>;
  }

  /**
   * Run the observer to compress un-observed messages into observations.
   * Only runs if un-observed messages exceed the token threshold.
   * Splits large message sets into batches to avoid choking the worker model.
   * Watermark advances per-batch so partial progress is preserved on failure.
   * Returns true if any observations were created.
   */
  async runObserver(conversationId: string): Promise<boolean> {
    if (!this.workerConfig) return false;

    const unobserved = await this.getUnobservedMessages(conversationId);
    if (unobserved.length === 0) return false;

    const tokenCount = estimateMessageTokens(unobserved);
    if (tokenCount < OBSERVER_THRESHOLD) return false;

    const batches = this.batchMessages(unobserved, OBSERVER_MAX_BATCH_TOKENS);
    this.log.info(
      `Observer triggered: ${unobserved.length} messages, ~${tokenCount} tokens, ${batches.length} batch(es)`,
    );

    let anyCreated = false;

    for (const batch of batches) {
      try {
        const result = await observe(
          this.workerConfig,
          {
            messages: batch.map((m) => ({
              role: m.role,
              content: m.content,
              created_at: m.created_at,
            })),
          },
          this.log,
          this.observerPrompt,
        );

        const messageIds = batch.map((m) => m.id);
        const lastMessageId = messageIds[messageIds.length - 1];

        // Store observations from this batch
        for (const obs of result.observations) {
          await this.storeObservation(conversationId, obs, messageIds, 0);
        }

        // Advance watermark for this batch — partial progress is preserved
        await this.db
          .updateTable("conversations")
          .set({ observed_up_to_message_id: lastMessageId })
          .where("id", "=", conversationId)
          .execute();

        if (result.observations.length > 0) {
          anyCreated = true;
          this.log.info(
            `Observer batch: ${result.observations.length} observations from ${batch.length} messages`,
          );
        }

        // Track usage per batch
        if (result.usage) {
          await trackUsage(this.db, {
            model: this.workerConfig.model,
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            cost_usd: null,
            source: "observer",
          });
        }
      } catch (err) {
        this.log.error(`Observer batch failed (${batch.length} messages): ${err}`);
        // Continue with next batch — don't abort the whole run
      }
    }

    // Recalculate observation token count once at the end
    if (anyCreated) {
      const activeObs = await this.getActiveObservations(conversationId);
      const newTokenCount = activeObs.reduce((sum, o) => sum + o.token_count, 0);
      await this.db
        .updateTable("conversations")
        .set({ observation_token_count: newTokenCount })
        .where("id", "=", conversationId)
        .execute();
    }

    return anyCreated;
  }

  /**
   * Run the reflector to condense observations when they exceed the threshold.
   * Wrap supersede + store in a transaction so failures don't leave partial state.
   * Skips condensed observations whose content already exists in active observations
   * (prevents duplicate condensed entries on re-run).
   * Returns true if observations were condensed.
   */
  async runReflector(
    conversationId: string,
  ): Promise<{ ran: boolean; usage?: { input_tokens: number; output_tokens: number } }> {
    if (!this.workerConfig) return { ran: false };

    const observations = await this.getActiveObservations(conversationId);
    if (observations.length === 0) return { ran: false };

    const totalTokens = observations.reduce((sum, o) => sum + o.token_count, 0);
    if (totalTokens < REFLECTOR_THRESHOLD) return { ran: false };

    this.log.info(
      `Reflector triggered: ${observations.length} observations, ~${totalTokens} tokens`,
    );

    try {
      const result = await reflect(
        this.workerConfig,
        { observations },
        this.log,
        this.reflectorPrompt,
      );

      // Collect existing active observation content for dedup
      const existingContents = new Set(observations.map((o) => o.content));

      // Wrap supersede + store in a transaction
      await this.db.transaction().execute(async (trx) => {
        if (result.superseded_ids.length > 0) {
          await trx
            .updateTable("observations")
            .set({ superseded_at: sql<string>`datetime('now')` })
            .where("id", "in", result.superseded_ids)
            .execute();
        }

        const maxGen = Math.max(...observations.map((o) => o.generation), 0);
        for (const obs of result.observations) {
          // Skip if an active observation already has this content (idempotency)
          if (existingContents.has(obs.content)) continue;

          await this.storeObservation(conversationId, obs, null, maxGen + 1);
        }
      });

      // Update observation token count
      const newObservations = await this.getActiveObservations(conversationId);
      const newTokenCount = newObservations.reduce((sum, o) => sum + o.token_count, 0);
      await this.db
        .updateTable("conversations")
        .set({ observation_token_count: newTokenCount })
        .where("id", "=", conversationId)
        .execute();

      this.log.info(
        `Reflector: ${result.superseded_ids.length} superseded, ${result.observations.length} new`,
      );

      // Track usage
      if (result.usage) {
        await trackUsage(this.db, {
          model: this.workerConfig.model,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cost_usd: null,
          source: "reflector",
        });
      }

      return { ran: true, usage: result.usage };
    } catch (err) {
      this.log.error(`Reflector failed: ${err}`);
      return { ran: false };
    }
  }

  /**
   * Promote novel medium/high-priority observations into the memories table.
   * Uses embedding-based dedup against existing memories (threshold: 0.85).
   * Embeddings are generated in parallel; dedup and storage run sequentially.
   * Only observations that were successfully processed get marked promoted_at —
   * failures remain eligible for retry on the next turn.
   * Returns count of promoted observations.
   */
  async promoteObservations(conversationId: string): Promise<number> {
    if (!this.workerConfig) return 0;

    // 1. Get unpromoted medium/high observations (generation=0 only — reflector-merged
    //    observations are derived from already-promoted facts; re-promoting them risks
    //    near-duplicate memories)
    const candidates = await this.db
      .selectFrom("observations")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .where("superseded_at", "is", null)
      .where("promoted_at", "is", null)
      .where("priority", "in", ["medium", "high"])
      .where("generation", "=", 0)
      .orderBy("created_at", "asc")
      .execute();

    if (candidates.length === 0) return 0;

    // 2. Load all existing memory embeddings for dedup
    const allMemories = await this.db
      .selectFrom("memories")
      .select(["id", "embedding"])
      .where("archived_at", "is", null)
      .where("embedding", "is not", null)
      .execute();

    const existingEmbeddings: number[][] = allMemories.map(
      (m) => JSON.parse(m.embedding!) as number[],
    );

    // 3. Generate embeddings in parallel for all candidates
    const results = await generateEmbeddings(
      this.apiKey,
      candidates.map((c) => c.content),
      this.embeddingModel,
    );

    // 4. Process results sequentially for intra-batch dedup.
    //    Each observation is marked promoted_at individually as it is processed,
    //    so partial progress survives crashes. Novel memories are wrapped in a
    //    transaction to keep insert + promoted_at update atomic.
    const batchEmbeddings: number[][] = [];
    let promoted = 0;

    for (const result of results) {
      if ("error" in result) {
        this.log.error(
          `Embedding failed for observation [${candidates[result.index].id}]: ${result.error}`,
        );
        continue;
      }

      const obs = candidates[result.index];
      const embedding = result.embedding;

      try {
        // Check against existing + batch embeddings
        let maxSim = 0;
        for (const other of existingEmbeddings) {
          const sim = cosineSimilarity(embedding, other);
          if (sim > maxSim) maxSim = sim;
        }
        for (const other of batchEmbeddings) {
          const sim = cosineSimilarity(embedding, other);
          if (sim > maxSim) maxSim = sim;
        }

        if (maxSim < 0.85) {
          // Novel — store memory + mark promoted atomically
          const memory = await this.db.transaction().execute(async (trx) => {
            const mem = await storeMemory(trx, {
              content: obs.content,
              category: "observation",
              source: "observer",
              embedding: JSON.stringify(embedding),
              tags: null,
            });

            await trx
              .updateTable("observations")
              .set({ promoted_at: sql<string>`datetime('now')` })
              .where("id", "=", obs.id)
              .execute();

            return mem;
          });

          batchEmbeddings.push(embedding);
          existingEmbeddings.push(embedding);
          promoted++;

          // Fire graph extraction async
          this.processStoredMemory(memory.id, memory.content).catch((err) =>
            this.log.error(`Graph extraction failed for promoted observation: ${err}`),
          );

          this.log.info(
            `Promoted observation -> memory [${memory.id}]: ${obs.content.slice(0, 80)}`,
          );
        } else {
          this.log.debug(
            `Skipped duplicate observation (sim=${maxSim.toFixed(3)}): ${obs.content.slice(0, 60)}`,
          );

          // Mark duplicate as processed so it won't be re-candidate
          await this.db
            .updateTable("observations")
            .set({ promoted_at: sql<string>`datetime('now')` })
            .where("id", "=", obs.id)
            .execute();
        }
      } catch (err) {
        this.log.error(`Failed to store promoted observation [${obs.id}]: ${err}`);
        // Don't mark — will retry next turn
      }
    }

    if (promoted > 0) {
      this.log.info(`Promoted ${promoted}/${candidates.length} observations to memories`);
    }

    return promoted;
  }

  /**
   * Build the context for a conversation:
   * 1. Get active observations (stable prefix)
   * 2. Get un-observed messages (active suffix)
   * Returns the observations text and active messages for replay.
   */
  async buildContext(conversationId: string): Promise<{
    observationsText: string;
    activeMessages: CairnMessage[];
    hasObservations: boolean;
    evictedObservations: number;
  }> {
    const observations = await this.getActiveObservations(conversationId);
    const activeMessages = await this.getUnobservedMessages(conversationId);

    // Fast path: if total tokens fit in budget, no sorting overhead needed
    const totalTokens = observations.reduce((sum, o) => sum + o.token_count, 0);
    if (totalTokens <= OBSERVATION_BUDGET) {
      return {
        observationsText: renderObservations(observations),
        activeMessages,
        hasObservations: observations.length > 0,
        evictedObservations: 0,
      };
    }

    // Over budget: use budgeted rendering with priority-based eviction
    const budgeted = renderObservationsWithBudget(observations);
    return {
      observationsText: budgeted.text,
      activeMessages,
      hasObservations: observations.length > 0,
      evictedObservations: budgeted.evicted,
    };
  }
}
