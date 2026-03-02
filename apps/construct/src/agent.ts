import {
  Agent,
  type AgentTool,
  type AgentToolResult,
} from '@mariozechner/pi-agent-core'
import { getModel, type Usage } from '@mariozechner/pi-ai'
import type { Static, TSchema } from '@sinclair/typebox'
import type { Kysely } from 'kysely'

import { env } from './env.js'
import { getSystemPrompt, buildContextPreamble } from './system-prompt.js'
import { agentLog, toolLog } from './logger.js'
import type { Database } from './db/schema.js'
import type { TelegramContext } from './telegram/types.js'
import {
  getOrCreateConversation,
  getRecentMessages,
  getRecentMemories,
  recallMemories,
  saveMessage,
  trackUsage,
} from './db/queries.js'
import { generateEmbedding, MemoryManager, type WorkerModelConfig } from '@repo/cairn'
import { selectAndCreateTools, type InternalTool } from './tools/packs.js'
import { selectSkills, getExtensionRegistry, selectAndCreateDynamicTools } from './extensions/index.js'

// Adapt internal tool → pi-agent-core AgentTool
function createPiTool<T extends TSchema>(
  tool: InternalTool<T>,
): AgentTool<T, unknown> {
  return {
    name: tool.name,
    label: tool.name.replace(/_/g, ' '),
    description: tool.description,
    parameters: tool.parameters,
    execute: async (
      toolCallId: string,
      params: Static<T>,
    ): Promise<AgentToolResult<unknown>> => {
      toolLog.info`Executing tool: ${tool.name}`
      toolLog.debug`Tool params: ${JSON.stringify(params)}`
      try {
        const result = await tool.execute(toolCallId, params)
        toolLog.info`Tool ${tool.name} completed`
        return {
          content: [{ type: 'text', text: result.output }],
          details: result.details,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toolLog.error`Tool ${tool.name} failed: ${msg}`
        return {
          content: [{ type: 'text', text: `Tool error: ${msg}` }],
          details: { error: msg },
        }
      }
    },
  }
}

export interface AgentResponse {
  text: string
  toolCalls: Array<{ name: string; args: unknown; result: string }>
  usage?: { input: number; output: number; cost: number }
  messageId?: string
}

export interface ProcessMessageOpts {
  source: 'telegram' | 'cli' | 'scheduler'
  externalId: string | null
  chatId?: string
  telegram?: TelegramContext
  replyContext?: string
  incomingTelegramMessageId?: number
}

export const isDev = env.NODE_ENV === 'development'

export async function processMessage(
  db: Kysely<Database>,
  message: string,
  opts: ProcessMessageOpts,
): Promise<AgentResponse> {
  agentLog.info`Processing message from ${opts.source}${opts.chatId ? ` (chat ${opts.chatId})` : ''}`

  // 1. Get or create conversation
  const conversationId = await getOrCreateConversation(
    db,
    opts.source,
    opts.externalId,
  )

  // 2. Create MemoryManager for this conversation
  const workerConfig: WorkerModelConfig | null = env.MEMORY_WORKER_MODEL
    ? { apiKey: env.OPENROUTER_API_KEY, model: env.MEMORY_WORKER_MODEL }
    : null
  const memoryManager = new MemoryManager(db, {
    workerConfig,
    embeddingModel: env.EMBEDDING_MODEL,
    apiKey: env.OPENROUTER_API_KEY,
  })

  // 3. Load context: observations (stable prefix) + un-observed messages (active suffix)
  // Falls back to last 20 messages if no observations exist yet
  const { observationsText, activeMessages, hasObservations, evictedObservations } =
    await memoryManager.buildContext(conversationId)

  let historyMessages: Array<{ role: string; content: string; telegram_message_id: number | null }>
  if (hasObservations) {
    // Use only un-observed messages — observations cover the rest
    historyMessages = activeMessages
    agentLog.debug`Context: ${observationsText.split('\n').length} observations, ${activeMessages.length} active messages${evictedObservations > 0 ? `, ${evictedObservations} evicted` : ''}`
  } else {
    // No observations yet — fall back to recent messages (current behavior)
    const recentMessages = await getRecentMessages(db, conversationId, 20)
    historyMessages = recentMessages
    agentLog.debug`Loaded ${recentMessages.length} history messages (no observations)`
  }

  // 4. Load memories for context injection
  const recentMemories = await getRecentMemories(db, 10)

  // Try to find semantically relevant memories for this specific message
  // queryEmbedding is also reused for tool pack selection below
  let queryEmbedding: number[] | undefined
  let relevantMemories: Array<{ content: string; category: string; score?: number }> = []
  try {
    queryEmbedding = await generateEmbedding(env.OPENROUTER_API_KEY, message, env.EMBEDDING_MODEL)
    const results = await recallMemories(db, message, {
      limit: 5,
      queryEmbedding,
      similarityThreshold: 0.4,
    })
    // Filter out any that are already in recent memories
    const recentIds = new Set(recentMemories.map((m) => m.id))
    relevantMemories = results
      .filter((m) => !recentIds.has(m.id))
      .map((m) => ({ content: m.content, category: m.category, score: m.score }))
  } catch {
    // Embedding call failed — no relevant memories, that's fine
    // queryEmbedding stays undefined → all tool packs will load (graceful fallback)
  }

  agentLog.debug`Context: ${recentMemories.length} recent memories, ${relevantMemories.length} relevant memories`

  // 5. Select relevant skills based on query embedding
  const selectedSkills = selectSkills(queryEmbedding)
  if (selectedSkills.length > 0) {
    agentLog.debug`Selected skills: ${selectedSkills.map((s) => s.name).join(', ')}`
  }

  // 6. Build context preamble (dynamic, prepended to user message)
  const preamble = buildContextPreamble({
    timezone: env.TIMEZONE,
    source: opts.source,
    dev: isDev,
    observations: observationsText || undefined,
    recentMemories: recentMemories.map((m) => ({
      content: m.content,
      category: m.category,
      created_at: m.created_at,
    })),
    relevantMemories,
    skills: selectedSkills,
    replyContext: opts.replyContext,
  })

  // 7. Create agent with system prompt (base + identity files)
  const { identity } = getExtensionRegistry()
  const model = getModel('openrouter', env.OPENROUTER_MODEL as Parameters<typeof getModel>[1])
  const agent = new Agent({
    initialState: {
      systemPrompt: getSystemPrompt(identity),
      model,
    },
  })

  agent.setModel(model)

  // 8. Select tool packs based on message embedding and create tools
  const chatId = opts.chatId ?? opts.externalId ?? 'unknown'
  const toolCtx = {
    db,
    chatId,
    apiKey: env.OPENROUTER_API_KEY,
    projectRoot: env.PROJECT_ROOT,
    dbPath: env.DATABASE_URL,
    timezone: env.TIMEZONE,
    tavilyApiKey: env.TAVILY_API_KEY,
    logFile: env.LOG_FILE,
    isDev,
    extensionsDir: env.EXTENSIONS_DIR,
    telegram: opts.telegram,
    memoryManager,
    embeddingModel: env.EMBEDDING_MODEL,
  }
  const builtinTools = selectAndCreateTools(queryEmbedding, toolCtx)
  const dynamicTools = selectAndCreateDynamicTools(queryEmbedding, toolCtx)
  const tools = [...builtinTools, ...dynamicTools]
  agent.setTools(tools.map((t) => createPiTool(t)))

  // 9. Replay conversation history so the agent has multi-turn context
  for (const msg of historyMessages) {
    const tgPrefix = msg.telegram_message_id ? `[tg:${msg.telegram_message_id}] ` : ''
    if (msg.role === 'user') {
      agent.appendMessage({ role: 'user', content: tgPrefix + msg.content, timestamp: Date.now() })
    } else if (msg.role === 'assistant') {
      agent.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: tgPrefix + msg.content }],
        api: 'openrouter' as any,
        provider: 'openrouter' as any,
        model: env.OPENROUTER_MODEL,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      })
    }
  }

  // 10. Track tool calls, response text, and usage
  let responseText = ''
  const toolCalls: AgentResponse['toolCalls'] = []
  const totalUsage = { input: 0, output: 0, cost: 0 }
  let hasUsage = false

  agent.subscribe((event) => {
    if (event.type === 'message_update') {
      if (event.assistantMessageEvent.type === 'text_delta') {
        responseText += event.assistantMessageEvent.delta
      }
    }
    if (event.type === 'message_end') {
      const msg = event.message
      if ('usage' in msg) {
        const u = msg.usage as Usage
        totalUsage.input += u.input
        totalUsage.output += u.output
        totalUsage.cost += u.cost.total
        hasUsage = true
      }
    }
    if (event.type === 'tool_execution_end') {
      toolCalls.push({
        name: event.toolName,
        args: undefined,
        result: String(event.result),
      })
    }
  })

  // 11. Save user message
  await saveMessage(db, {
    conversation_id: conversationId,
    role: 'user',
    content: message,
    telegram_message_id: opts.incomingTelegramMessageId ?? null,
  })

  // 12. Run agent — prepend context preamble to first message
  agentLog.debug`Prompting agent`
  await agent.prompt(preamble + message)
  await agent.waitForIdle()
  agentLog.info`Agent finished. Response length: ${responseText.length}, tool calls: ${toolCalls.length}`

  // Strip leaked [tg:ID] prefixes from response (LLM sometimes echoes them from history)
  responseText = responseText.replace(/\[tg:\d+\]\s*/g, '')

  // 13. Save assistant response
  const assistantMessageId = await saveMessage(db, {
    conversation_id: conversationId,
    role: 'assistant',
    content: responseText,
    tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
  })

  // 14. Track usage
  if (hasUsage) {
    agentLog.info`Usage: ${totalUsage.input} in / ${totalUsage.output} out / $${totalUsage.cost.toFixed(4)}`
    await trackUsage(db, {
      model: env.OPENROUTER_MODEL,
      input_tokens: totalUsage.input,
      output_tokens: totalUsage.output,
      cost_usd: totalUsage.cost,
      source: opts.source,
    })
  }

  // 15. Run observer async after response (next turn benefits)
  // Non-blocking — fires and forgets. Observer only runs if un-observed
  // messages exceed the token threshold.
  memoryManager.runObserver(conversationId)
    .then(async (ran: boolean) => {
      if (ran) {
        // Promote novel observations to searchable memories before reflector condenses them
        await memoryManager.promoteObservations(conversationId)
        // Then check if reflector should condense
        return memoryManager.runReflector(conversationId)
      }
    })
    .catch((err: unknown) => agentLog.error`Post-response observation failed: ${err}`)

  const usage = hasUsage ? totalUsage : undefined

  return { text: responseText, toolCalls, usage, messageId: assistantMessageId }
}
