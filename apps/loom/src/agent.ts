import { Agent } from '@mariozechner/pi-agent-core'
import { getModel, type Usage } from '@mariozechner/pi-ai'
import type { Kysely } from 'kysely'

import { env } from './env.js'
import { getSystemPrompt, buildContextPreamble } from './system-prompt.js'
import type { Database } from './db/schema.js'
import {
  getSession,
  getCampaign,
  getMessages,
  saveMessage,
  recallMemories,
  getRecentMemories,
  trackUsage,
} from './db/queries.js'
import { generateEmbedding, MemoryManager, type WorkerModelConfig } from '@repo/cairn'

export interface ProcessMessageOpts {
  onDelta?: (text: string) => void
}

export async function processMessage(
  db: Kysely<Database>,
  sessionId: string,
  message: string,
  opts: ProcessMessageOpts = {},
): Promise<{ responseText: string }> {
  // 1. Look up session + campaign
  const session = await getSession(db, sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)

  const campaign = await getCampaign(db, session.campaign_id)
  if (!campaign) throw new Error(`Campaign not found: ${session.campaign_id}`)

  const conversationId = session.conversation_id

  // 2. Create MemoryManager
  const workerConfig: WorkerModelConfig | null = env.MEMORY_WORKER_MODEL
    ? { apiKey: env.OPENROUTER_API_KEY, model: env.MEMORY_WORKER_MODEL, extraBody: { reasoning: { max_tokens: 1 } } }
    : null
  const memoryManager = new MemoryManager(db, {
    workerConfig,
    embeddingModel: env.EMBEDDING_MODEL,
    apiKey: env.OPENROUTER_API_KEY,
  })

  // 3. Build context
  const { observationsText, activeMessages, hasObservations } =
    await memoryManager.buildContext(conversationId)

  let historyMessages: Array<{ role: string; content: string }>
  if (hasObservations) {
    historyMessages = activeMessages
  } else {
    historyMessages = await getMessages(db, conversationId, 20)
  }

  // 4. Recall rules + campaign memories
  let queryEmbedding: number[] | undefined
  let rulesMemories: Array<{ content: string }> = []
  let campaignMemories: Array<{ content: string; category: string }> = []

  try {
    queryEmbedding = await generateEmbedding(env.OPENROUTER_API_KEY, message, env.EMBEDDING_MODEL)

    const rulesResults = await recallMemories(db, message, {
      category: 'rules',
      limit: 5,
      queryEmbedding,
      similarityThreshold: 0.3,
    })
    rulesMemories = rulesResults.map((m) => ({ content: m.content }))

    const campaignResults = await recallMemories(db, message, {
      limit: 5,
      queryEmbedding,
      similarityThreshold: 0.3,
    })
    const recentMems = await getRecentMemories(db, 10)
    const seen = new Set(campaignResults.map((m) => m.id))
    const combined = [...campaignResults]
    for (const m of recentMems) {
      if (!seen.has(m.id) && m.category !== 'rules') {
        combined.push(m)
        seen.add(m.id)
      }
    }
    campaignMemories = combined
      .filter((m) => m.category !== 'rules')
      .map((m) => ({ content: m.content, category: m.category }))
  } catch {
    // Embedding call failed — proceed without memories
  }

  // 5. Build preamble
  const preamble = buildContextPreamble({
    timezone: env.TIMEZONE,
    mode: session.mode,
    campaignName: campaign.name,
    campaignSystem: campaign.system,
    observations: observationsText || undefined,
    rulesMemories: rulesMemories.length > 0 ? rulesMemories : undefined,
    campaignMemories: campaignMemories.length > 0 ? campaignMemories : undefined,
  })

  // 6. Create agent
  const model = getModel('openrouter', env.OPENROUTER_MODEL as Parameters<typeof getModel>[1])
  const agent = new Agent({
    initialState: {
      systemPrompt: getSystemPrompt(),
      model,
    },
  })
  agent.setModel(model)

  // 7. Replay history
  for (const msg of historyMessages) {
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

  // 8. Track response and usage
  let responseText = ''
  const totalUsage = { input: 0, output: 0, cost: 0 }
  let hasUsage = false

  agent.subscribe((event) => {
    if (event.type === 'message_update') {
      if (event.assistantMessageEvent.type === 'text_delta') {
        const delta = event.assistantMessageEvent.delta
        responseText += delta
        opts.onDelta?.(delta)
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
  })

  // 9. Save user message + prompt agent
  await saveMessage(db, {
    conversation_id: conversationId,
    role: 'user',
    content: message,
  })

  await agent.prompt(preamble + message)
  await agent.waitForIdle()

  // 10. Save assistant response
  await saveMessage(db, {
    conversation_id: conversationId,
    role: 'assistant',
    content: responseText,
  })

  // 11. Track usage
  if (hasUsage) {
    await trackUsage(db, {
      model: env.OPENROUTER_MODEL,
      input_tokens: totalUsage.input,
      output_tokens: totalUsage.output,
      cost_usd: totalUsage.cost,
      source: 'loom',
    })
  }

  // 12. Run memory pipeline async
  memoryManager.runObserver(conversationId)
    .then(async (ran: boolean) => {
      if (ran) {
        await memoryManager.promoteObservations(conversationId)
        return memoryManager.runReflector(conversationId)
      }
    })
    .catch((err: unknown) => console.error('Post-response observation failed:', err))

  return { responseText }
}
