import type { TSchema } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import type { TelegramContext } from '../telegram/types.js'
import { generateEmbedding, cosineSimilarity, type MemoryManager } from '@repo/cairn'
import { agentLog } from '../logger.js'

import { createMemoryStoreTool } from './core/memory-store.js'
import { createMemoryRecallTool } from './core/memory-recall.js'
import { createMemoryForgetTool } from './core/memory-forget.js'
import { createMemoryGraphTool } from './core/memory-graph.js'
import { createScheduleCreateTool, createScheduleListTool, createScheduleCancelTool } from './core/schedule.js'
import { createWebReadTool } from './web/web-read.js'
import { createWebSearchTool } from './web/web-search.js'
import { createSelfReadTool } from './self/self-read.js'
import { createSelfEditTool } from './self/self-edit.js'
import { createSelfTestTool } from './self/self-test.js'
import { createSelfLogsTool } from './self/self-logs.js'
import { createSelfDeployTool } from './self/self-deploy.js'
import { createSelfStatusTool } from './self/self-status.js'
import { createExtensionReloadTool } from './self/extension-reload.js'
import { createSecretStoreTool, createSecretListTool, createSecretDeleteTool } from './core/secret-manage.js'
import { createUsageStatsTool } from './core/usage-stats.js'
import { createIdentityReadTool } from './core/identity-read.js'
import { createIdentityUpdateTool } from './core/identity-update.js'
import { createTelegramReactTool } from './telegram/telegram-react.js'
import { createTelegramReplyToTool } from './telegram/telegram-reply-to.js'
import { createTelegramPinTool } from './telegram/telegram-pin.js'
import { createTelegramUnpinTool } from './telegram/telegram-unpin.js'
import { createTelegramGetPinnedTool } from './telegram/telegram-get-pinned.js'
import { createTelegramAskTool } from './telegram/telegram-ask.js'

// --- Types ---

export interface InternalTool<T extends TSchema> {
  name: string
  description: string
  parameters: T
  execute: (
    toolCallId: string,
    args: unknown,
  ) => Promise<{ output: string; details?: unknown }>
}

export interface ToolContext {
  db: Kysely<Database>
  chatId: string
  apiKey: string
  projectRoot: string
  dbPath: string
  timezone: string
  tavilyApiKey?: string
  logFile?: string
  isDev: boolean
  extensionsDir?: string
  telegram?: TelegramContext
  memoryManager?: MemoryManager
  embeddingModel?: string
}

export type ToolFactory = (ctx: ToolContext) => InternalTool<TSchema> | null

export interface ToolPack {
  name: string
  description: string
  alwaysLoad: boolean
  factories: ToolFactory[]
}

// --- Pack definitions ---

export const TOOL_PACKS: ToolPack[] = [
  {
    name: 'core',
    description: 'Long-term memory storage and recall, scheduled reminders and recurring tasks',
    alwaysLoad: true,
    factories: [
      (ctx) => createMemoryStoreTool(ctx.db, ctx.apiKey, ctx.memoryManager, ctx.embeddingModel) as InternalTool<TSchema>,
      (ctx) => createMemoryRecallTool(ctx.db, ctx.apiKey, ctx.embeddingModel) as InternalTool<TSchema>,
      (ctx) => createMemoryForgetTool(ctx.db) as InternalTool<TSchema>,
      (ctx) => createMemoryGraphTool(ctx.db) as InternalTool<TSchema>,
      (ctx) => createScheduleCreateTool(ctx.db, ctx.chatId, ctx.timezone, ctx.apiKey, ctx.embeddingModel) as InternalTool<TSchema>,
      (ctx) => createScheduleListTool(ctx.db, ctx.timezone) as InternalTool<TSchema>,
      (ctx) => createScheduleCancelTool(ctx.db) as InternalTool<TSchema>,
      (ctx) => createSecretStoreTool(ctx.db) as InternalTool<TSchema>,
      (ctx) => createSecretListTool(ctx.db) as InternalTool<TSchema>,
      (ctx) => createSecretDeleteTool(ctx.db) as InternalTool<TSchema>,
      (ctx) => createUsageStatsTool(ctx.db) as InternalTool<TSchema>,
      (ctx) => ctx.extensionsDir ? createIdentityReadTool(ctx.extensionsDir) as InternalTool<TSchema> : null,
      (ctx) => ctx.extensionsDir ? createIdentityUpdateTool(ctx.extensionsDir) as InternalTool<TSchema> : null,
    ],
  },
  {
    name: 'web',
    description: 'Search the web, read web pages, fetch news, weather, documentation, and articles',
    alwaysLoad: false,
    factories: [
      () => createWebReadTool() as InternalTool<TSchema>,
      (ctx) => ctx.tavilyApiKey ? createWebSearchTool(ctx.tavilyApiKey) as InternalTool<TSchema> : null,
    ],
  },
  {
    name: 'self',
    description: 'Read, edit, test, and deploy own source code. View service logs and system health. Self-modification.',
    alwaysLoad: false,
    factories: [
      (ctx) => createSelfReadTool(ctx.projectRoot, ctx.extensionsDir) as InternalTool<TSchema>,
      (ctx) => createSelfEditTool(ctx.projectRoot, ctx.extensionsDir) as InternalTool<TSchema>,
      (ctx) => createSelfTestTool(ctx.projectRoot) as InternalTool<TSchema>,
      (ctx) => createSelfLogsTool(ctx.logFile) as InternalTool<TSchema>,
      (ctx) => createSelfStatusTool(ctx.dbPath, ctx.logFile) as InternalTool<TSchema>,
      (ctx) => ctx.isDev ? null : createSelfDeployTool(ctx.projectRoot) as InternalTool<TSchema>,
      () => createExtensionReloadTool() as InternalTool<TSchema>,
    ],
  },
  {
    name: 'telegram',
    description: 'React with emoji, reply to specific messages, pin/unpin messages in Telegram',
    alwaysLoad: true,
    factories: [
      (ctx) => ctx.telegram ? createTelegramReactTool(ctx.telegram) as InternalTool<TSchema> : null,
      (ctx) => ctx.telegram ? createTelegramReplyToTool(ctx.telegram) as InternalTool<TSchema> : null,
      (ctx) => ctx.telegram ? createTelegramPinTool(ctx.telegram) as InternalTool<TSchema> : null,
      (ctx) => ctx.telegram ? createTelegramUnpinTool(ctx.telegram) as InternalTool<TSchema> : null,
      (ctx) => ctx.telegram ? createTelegramGetPinnedTool(ctx.telegram) as InternalTool<TSchema> : null,
      (ctx) => ctx.telegram ? createTelegramAskTool(ctx.db, ctx.telegram) as InternalTool<TSchema> : null,
    ],
  },
]

// --- Embedding cache ---

const packEmbeddings = new Map<string, number[]>()

/**
 * Pre-compute embeddings for non-alwaysLoad pack descriptions.
 * Called once at startup. Failures are non-fatal — packs with missing
 * embeddings fall back to always loading.
 */
export async function initPackEmbeddings(apiKey: string, embeddingModel?: string): Promise<void> {
  const packsToEmbed = TOOL_PACKS.filter((p) => !p.alwaysLoad)

  const results = await Promise.allSettled(
    packsToEmbed.map(async (pack) => {
      const embedding = await generateEmbedding(apiKey, pack.description, embeddingModel)
      packEmbeddings.set(pack.name, embedding)
    }),
  )

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const pack = packsToEmbed[i]
    if (result.status === 'rejected') {
      agentLog.warning`Failed to embed pack "${pack.name}": ${result.reason}. Will always load.`
    }
  }

  agentLog.info`Pack embeddings initialized: ${packEmbeddings.size}/${packsToEmbed.length} cached`
}

// --- Selection ---

const DEFAULT_THRESHOLD = 0.3

/**
 * Select which packs to load based on query embedding similarity.
 * Pure function — testable without side effects.
 *
 * Fallback rules:
 * - alwaysLoad packs → always included
 * - No queryEmbedding (API failure) → all packs loaded
 * - No packEmbedding (init failure) → that pack loaded
 * - Otherwise → cosine similarity ≥ threshold → include
 */
export function selectPacks(
  queryEmbedding: number[] | undefined,
  packs: ToolPack[],
  embeddings: Map<string, number[]>,
  threshold = DEFAULT_THRESHOLD,
): ToolPack[] {
  // No query embedding → load everything (graceful fallback)
  if (!queryEmbedding) {
    return packs
  }

  return packs.filter((pack) => {
    if (pack.alwaysLoad) return true

    const packEmb = embeddings.get(pack.name)
    // No embedding for this pack → load it (graceful fallback)
    if (!packEmb) return true

    const similarity = cosineSimilarity(queryEmbedding, packEmb)
    return similarity >= threshold
  })
}

/**
 * Select packs and instantiate tools for a given message context.
 * Uses the module-level embedding cache.
 */
export function selectAndCreateTools(
  queryEmbedding: number[] | undefined,
  ctx: ToolContext,
): InternalTool<TSchema>[] {
  const selected = selectPacks(queryEmbedding, TOOL_PACKS, packEmbeddings)

  agentLog.info`Selected packs: ${selected.map((p) => p.name).join(', ')}`

  const tools: InternalTool<TSchema>[] = []
  for (const pack of selected) {
    for (const factory of pack.factories) {
      const tool = factory(ctx)
      if (tool) tools.push(tool)
    }
  }

  return tools
}
