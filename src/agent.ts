import {
  Agent,
  type AgentTool,
  type AgentToolResult,
} from '@mariozechner/pi-agent-core'
import { getModel, type Usage } from '@mariozechner/pi-ai'
import type { Static, TSchema } from '@sinclair/typebox'
import type { Kysely } from 'kysely'

import { env } from './env.js'
import { SYSTEM_PROMPT, buildContextPreamble } from './system-prompt.js'
import { agentLog, toolLog } from './logger.js'
import type { Database } from './db/schema.js'
import {
  getOrCreateConversation,
  getRecentMessages,
  getRecentMemories,
  recallMemories,
  saveMessage,
  trackUsage,
} from './db/queries.js'
import { generateEmbedding } from './embeddings.js'
import {
  createMemoryStoreTool,
  createMemoryRecallTool,
  createMemoryForgetTool,
  createScheduleCreateTool,
  createScheduleListTool,
  createScheduleCancelTool,
  createSelfReadTool,
  createSelfEditTool,
  createSelfTestTool,
  createSelfLogsTool,
  createSelfDeployTool,
  createWebReadTool,
  createWebSearchTool,
} from './tools/index.js'

// Internal tool shape (matches Basil's pattern)
interface InternalTool<T extends TSchema> {
  name: string
  description: string
  parameters: T
  execute: (
    toolCallId: string,
    args: Static<T>,
  ) => Promise<{ output: string; details?: unknown }>
}

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
}

export interface ProcessMessageOpts {
  source: 'telegram' | 'cli'
  externalId: string | null
  chatId?: string
}

export function createAllTools(db: Kysely<Database>, chatId: string) {
  const apiKey = env.OPENROUTER_API_KEY
  return [
    // Memory — pass API key for embedding generation
    createPiTool(createMemoryStoreTool(db, apiKey)),
    createPiTool(createMemoryRecallTool(db, apiKey)),
    createPiTool(createMemoryForgetTool(db)),
    // Scheduler — chatId auto-injected so LLM doesn't need to guess it
    createPiTool(createScheduleCreateTool(db, chatId)),
    createPiTool(createScheduleListTool(db)),
    createPiTool(createScheduleCancelTool(db)),
    // Web
    createPiTool(createWebReadTool()),
    ...(env.TAVILY_API_KEY ? [createPiTool(createWebSearchTool(env.TAVILY_API_KEY))] : []),
    // Self-aware
    createPiTool(createSelfReadTool(env.PROJECT_ROOT)),
    createPiTool(createSelfEditTool(env.PROJECT_ROOT)),
    createPiTool(createSelfTestTool(env.PROJECT_ROOT)),
    createPiTool(createSelfLogsTool()),
    createPiTool(createSelfDeployTool(env.PROJECT_ROOT)),
  ]
}

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

  // 2. Load recent history
  const recentMessages = await getRecentMessages(db, conversationId, 20)
  agentLog.debug`Loaded ${recentMessages.length} history messages`

  // 3. Load memories for context injection
  const recentMemories = await getRecentMemories(db, 10)

  // Try to find semantically relevant memories for this specific message
  let relevantMemories: Array<{ content: string; category: string; score?: number }> = []
  try {
    const queryEmbedding = await generateEmbedding(env.OPENROUTER_API_KEY, message)
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
  }

  agentLog.debug`Context: ${recentMemories.length} recent memories, ${relevantMemories.length} relevant memories`

  // 4. Build context preamble (dynamic, prepended to user message)
  const preamble = buildContextPreamble({
    timezone: env.TIMEZONE,
    source: opts.source,
    recentMemories: recentMemories.map((m) => ({
      content: m.content,
      category: m.category,
      created_at: m.created_at,
    })),
    relevantMemories,
  })

  // 4. Create agent with static system prompt (cacheable)
  const model = getModel('openrouter', env.OPENROUTER_MODEL as Parameters<typeof getModel>[1])
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
    },
  })

  agent.setModel(model)

  // Use chatId from opts, fall back to externalId for Telegram
  const chatId = opts.chatId ?? opts.externalId ?? 'unknown'
  agent.setTools(createAllTools(db, chatId))

  // 5. Replay conversation history so the agent has multi-turn context
  for (const msg of recentMessages) {
    if (msg.role === 'user') {
      agent.appendMessage({ role: 'user', content: msg.content, timestamp: Date.now() })
    } else if (msg.role === 'assistant') {
      agent.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: msg.content }],
        api: 'openrouter' as any,
        provider: 'openrouter' as any,
        model: env.OPENROUTER_MODEL,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      })
    }
  }

  // 6. Track tool calls, response text, and usage
  let responseText = ''
  const toolCalls: AgentResponse['toolCalls'] = []
  let lastUsage: Usage | undefined

  agent.subscribe((event) => {
    if (event.type === 'message_update') {
      if (event.assistantMessageEvent.type === 'text_delta') {
        responseText += event.assistantMessageEvent.delta
      }
    }
    if (event.type === 'message_end') {
      const msg = event.message
      if ('usage' in msg) {
        lastUsage = msg.usage as Usage
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

  // 7. Save user message
  await saveMessage(db, {
    conversation_id: conversationId,
    role: 'user',
    content: message,
  })

  // 8. Run agent — prepend context preamble to first message
  agentLog.debug`Prompting agent`
  await agent.prompt(preamble + message)
  await agent.waitForIdle()
  agentLog.info`Agent finished. Response length: ${responseText.length}, tool calls: ${toolCalls.length}`

  // 9. Save assistant response
  await saveMessage(db, {
    conversation_id: conversationId,
    role: 'assistant',
    content: responseText,
    tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
  })

  // 10. Track usage
  if (lastUsage) {
    agentLog.info`Usage: ${lastUsage.input} in / ${lastUsage.output} out / $${lastUsage.cost.total.toFixed(4)}`
    await trackUsage(db, {
      model: env.OPENROUTER_MODEL,
      input_tokens: lastUsage.input,
      output_tokens: lastUsage.output,
      cost_usd: lastUsage.cost.total,
      source: opts.source,
    })
  }

  const usage = lastUsage
    ? { input: lastUsage.input, output: lastUsage.output, cost: lastUsage.cost.total }
    : undefined

  return { text: responseText, toolCalls, usage }
}
