/**
 * PipelineQueue — lightweight in-process job queue backed by SQLite.
 *
 * Replaces fire-and-forget post-turn memory pipeline calls with persisted,
 * crash-recoverable jobs. On startup, any "running" jobs are reset to
 * "pending" (they were interrupted by a crash). Jobs are processed
 * sequentially with exponential backoff on failure.
 */

import type { Kysely } from "kysely";
import type { MemoryManager } from "./manager.js";
import type { CairnLogger } from "./types.js";
import { nullLogger } from "./types.js";

export interface PipelineJobRecord {
  id: string;
  type: string;
  conversation_id: string;
  status: "pending" | "running" | "completed" | "failed" | "dead_letter";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string;
  completed_at: string | null;
}

export interface PipelineStatus {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  dead_letter: number;
}

export interface PipelineQueueOptions {
  maxAttempts?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  logger?: CairnLogger;
  /** Optional callback invoked after a post_turn job completes successfully. */
  postTurnExtras?: (conversationId: string) => Promise<void>;
}

export class PipelineQueue {
  private running = false;
  private draining = false;
  private wakeupTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: Required<Omit<PipelineQueueOptions, "logger" | "postTurnExtras">> &
    Pick<PipelineQueueOptions, "postTurnExtras">;
  private readonly log: CairnLogger;

  constructor(
    private db: Kysely<any>,
    private memoryManager: MemoryManager,
    options: PipelineQueueOptions = {},
  ) {
    this.options = {
      maxAttempts: 3,
      backoffBaseMs: 1000,
      maxBackoffMs: 60000,
      ...options,
    };
    this.log = options.logger ?? nullLogger;
  }

  /**
   * Enqueue a job and kick off the drain loop. Returns the job ID immediately.
   * The caller does NOT await the job — it completes asynchronously.
   */
  async enqueue(type: string, conversationId: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .insertInto("pipeline_jobs")
      .values({ id, type, conversation_id: conversationId })
      .execute();
    this.log.debug(`PipelineQueue: enqueued ${type} job [${id}] for ${conversationId}`);
    this._kickDrain();
    return id;
  }

  /**
   * Start processing. On first call, resets any "running" jobs that were
   * interrupted by a crash back to "pending", then begins draining.
   */
  async start(): Promise<void> {
    // Reset stuck running jobs (crash recovery)
    const reset = await this.db
      .updateTable("pipeline_jobs")
      .set({ status: "pending" as const })
      .where("status", "=", "running")
      .executeTakeFirst();

    if (reset && Number(reset.numUpdatedRows) > 0) {
      this.log.info(
        `PipelineQueue: reset ${Number(reset.numUpdatedRows)} stuck running jobs to pending`,
      );
    }

    this.running = true;
    this._kickDrain();
  }

  /** Stop the drain loop. In-flight job completes, but no new jobs are picked up. */
  stop(): void {
    this.running = false;
    if (this.wakeupTimer) {
      clearTimeout(this.wakeupTimer);
      this.wakeupTimer = null;
    }
  }

  /** Get aggregate status for health checks. */
  async getStatus(): Promise<PipelineStatus> {
    const rows = await this.db
      .selectFrom("pipeline_jobs")
      .select(["status", this.db.fn.countAll<string>().as("count")])
      .groupBy("status")
      .execute();

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = Number(row.count);
    }

    return {
      pending: counts.pending || 0,
      running: counts.running || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      dead_letter: counts.dead_letter || 0,
    };
  }

  // ---- internals ----

  private _kickDrain(): void {
    if (this.draining || !this.running) return;
    if (this.wakeupTimer) {
      clearTimeout(this.wakeupTimer);
      this.wakeupTimer = null;
    }
    void this._drainLoop();
  }

  private async _drainLoop(): Promise<void> {
    this.draining = true;
    try {
      while (this.running) {
        const job = await this._dequeueNext();
        if (!job) break;
        await this._executeJob(job);
      }
      // Drain ended with no work — schedule a wakeup if there are future-pending jobs (retries).
      // Without this, retried jobs would never fire unless a new enqueue() arrived.
      if (this.running) await this._scheduleNextWakeup();
    } catch (err) {
      this.log.error(`PipelineQueue: drain loop error: ${err}`);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Look up the earliest pending job whose next_attempt_at is in the future and
   * schedule a single timer to re-kick the drain at that time. Macrotask-based,
   * so it yields the event loop to other I/O (Telegram polling, signal handlers).
   */
  private async _scheduleNextWakeup(): Promise<void> {
    const next = await this.db
      .selectFrom("pipeline_jobs")
      .select("next_attempt_at")
      .where("status", "=", "pending")
      .orderBy("next_attempt_at", "asc")
      .limit(1)
      .executeTakeFirst();
    if (!next || !this.running) return;

    const delay = Math.max(0, new Date(next.next_attempt_at).getTime() - Date.now());
    this.wakeupTimer = setTimeout(() => {
      this.wakeupTimer = null;
      this._kickDrain();
    }, delay);
    this.wakeupTimer.unref();
  }

  private async _dequeueNext(): Promise<PipelineJobRecord | null> {
    const job = await this.db
      .selectFrom("pipeline_jobs")
      .selectAll()
      .where("status", "=", "pending")
      .where("next_attempt_at", "<=", new Date().toISOString())
      .orderBy("created_at", "asc")
      .limit(1)
      .executeTakeFirst();

    if (!job) return null;

    // Atomically claim it
    const claimed = await this.db
      .updateTable("pipeline_jobs")
      .set({ status: "running" as const })
      .where("id", "=", job.id)
      .where("status", "=", "pending")
      .executeTakeFirst();

    if (!claimed || Number(claimed.numUpdatedRows) === 0) return null; // taken by another worker

    return job as PipelineJobRecord;
  }

  private async _executeJob(job: PipelineJobRecord): Promise<void> {
    this.log.debug(`PipelineQueue: executing ${job.type} job [${job.id}]`);

    try {
      switch (job.type) {
        case "observer": {
          const ran = await this.memoryManager.runObserver(job.conversation_id);
          if (ran) {
            await this._insertJob("promoter", job.conversation_id);
          }
          break;
        }
        case "promoter": {
          await this.memoryManager.promoteObservations(job.conversation_id);
          break;
        }
        case "reflector": {
          await this.memoryManager.runReflector(job.conversation_id);
          break;
        }
        case "post_turn": {
          // Full post-turn pipeline: observer → promoter → reflector
          const ran = await this.memoryManager.runObserver(job.conversation_id);
          if (ran) {
            await this.memoryManager.promoteObservations(job.conversation_id);
          }
          await this.memoryManager.runReflector(job.conversation_id);
          await this.options.postTurnExtras?.(job.conversation_id);
          break;
        }
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }

      await this.db
        .updateTable("pipeline_jobs")
        .set({
          status: "completed" as const,
          completed_at: new Date().toISOString(),
        })
        .where("id", "=", job.id)
        .execute();

      this.log.debug(`PipelineQueue: completed ${job.type} job [${job.id}]`);
    } catch (err) {
      const newAttempts = job.attempts + 1;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (newAttempts >= job.max_attempts) {
        await this.db
          .updateTable("pipeline_jobs")
          .set({
            status: "dead_letter" as const,
            last_error: errorMsg,
            attempts: newAttempts,
          })
          .where("id", "=", job.id)
          .execute();

        this.log.error(
          `PipelineQueue: ${job.type} job [${job.id}] dead_letter after ${newAttempts} attempts: ${errorMsg}`,
        );
      } else {
        const backoff = Math.min(
          this.options.backoffBaseMs * 2 ** (newAttempts - 1),
          this.options.maxBackoffMs,
        );
        const jitter = backoff * (0.75 + Math.random() * 0.5); // ±25% jitter
        const nextAttempt = new Date(Date.now() + jitter).toISOString();

        await this.db
          .updateTable("pipeline_jobs")
          .set({
            status: "pending" as const,
            last_error: errorMsg,
            attempts: newAttempts,
            next_attempt_at: nextAttempt,
          })
          .where("id", "=", job.id)
          .execute();

        this.log.warning(
          `PipelineQueue: ${job.type} job [${job.id}] retry ${newAttempts}/${job.max_attempts} in ${Math.round(jitter)}ms: ${errorMsg}`,
        );
      }
    }
  }

  /** Insert a job directly (no drain kick — drain loop will pick it up). */
  private async _insertJob(type: string, conversationId: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .insertInto("pipeline_jobs")
      .values({ id, type, conversation_id: conversationId })
      .execute();
    this.log.debug(`PipelineQueue: inserted follow-up ${type} job [${id}]`);
    return id;
  }
}
