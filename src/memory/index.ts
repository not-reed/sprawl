/**
 * MemoryManager — single entry point for the memory system.
 * Wraps Graph Memory and Observational Memory behind a clean facade.
 */

import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import type { WorkerModelConfig } from './types.js'
import { processMemoryForGraph } from './graph/index.js'
import { toolLog } from '../logger.js'
import { trackUsage } from '../db/queries.js'

export type { WorkerModelConfig } from './types.js'
export type { ExtractionResult } from './types.js'

export class MemoryManager {
  constructor(
    private db: Kysely<Database>,
    private workerConfig: WorkerModelConfig | null,
  ) {}

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

      // Track extraction usage
      if (result.usage) {
        await trackUsage(this.db, {
          model: this.workerConfig.model,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cost_usd: null, // cost is model-dependent, tracked as null for now
          source: 'graph_extract',
        })
      }
    } catch (err) {
      toolLog.error`Graph extraction failed for memory [${memoryId}]: ${err}`
    }
  }
}
