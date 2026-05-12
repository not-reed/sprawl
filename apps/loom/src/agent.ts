import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, type Usage } from "@mariozechner/pi-ai";
import type { Kysely } from "kysely";

import { env } from "./env.js";
import { getSystemPrompt, buildContextPreamble } from "./system-prompt.js";
import type { Database } from "./db/schema.js";
import {
  getSession,
  getCampaign,
  getMessages,
  saveMessage,
  recallMemories,
  getRecentMemories,
  trackUsage,
} from "./db/queries.js";
import {
  generateEmbedding,
  MemoryManager,
  SIMILARITY,
  searchNodesWithScores,
  spreadActivation,
  getRelatedMemoriesWithScores,
  type WorkerModelConfig,
} from "@repo/cairn";

export interface ProcessMessageOpts {
  onDelta?: (text: string) => void;
}

interface RecalledMemories {
  rulesMemories: Array<{ content: string }>;
  campaignMemories: Array<{ content: string; category: string }>;
}

async function expandWithGraph(
  db: Kysely<Database>,
  message: string,
  queryEmbedding: number[] | undefined,
  seen: Set<string>,
): Promise<Array<{ id: string; category: string; content: string }>> {
  const out: Array<{ id: string; category: string; content: string }> = [];
  try {
    const seedNodes = await searchNodesWithScores(db, message, 5, queryEmbedding);
    if (seedNodes.length === 0) return out;

    const seeds = seedNodes.map((s) => ({ nodeId: s.node.id, score: s.score }));
    const activated = await spreadActivation(db, seeds, { maxDepth: 2 });
    const nodeScoreMap = new Map<string, number>();
    for (const s of seedNodes) nodeScoreMap.set(s.node.id, s.score);
    for (const a of activated) nodeScoreMap.set(a.node.id, a.score);

    const scoredMems = await getRelatedMemoriesWithScores(db, nodeScoreMap);
    const newMemIds = scoredMems
      .filter((s) => !seen.has(s.memoryId))
      .slice(0, 5)
      .map((s) => s.memoryId);

    if (newMemIds.length === 0) return out;

    const graphMems = await db
      .selectFrom("memories")
      .selectAll()
      .where("id", "in", newMemIds)
      .where("archived_at", "is", null)
      .execute();
    for (const m of graphMems) {
      out.push(m as unknown as (typeof out)[number]);
      seen.add(m.id);
    }
  } catch (err) {
    // Graph expansion is optional — log at debug level so failures aren't silent
    console.debug("Graph expansion failed:", err);
  }
  return out;
}

async function recallMemoriesForQuery(
  db: Kysely<Database>,
  message: string,
): Promise<RecalledMemories> {
  let queryEmbedding: number[] | undefined;
  try {
    queryEmbedding = await generateEmbedding(env.OPENROUTER_API_KEY, message, env.EMBEDDING_MODEL);
  } catch {
    return { rulesMemories: [], campaignMemories: [] };
  }

  const rulesResults = await recallMemories(db, message, {
    category: "rules",
    limit: 5,
    queryEmbedding,
    similarityThreshold: SIMILARITY.RECALL_DEFAULT,
  });
  const rulesMemories = rulesResults.map((m) => ({ content: m.content }));

  const campaignResults = await recallMemories(db, message, {
    limit: 5,
    queryEmbedding,
    similarityThreshold: SIMILARITY.RECALL_DEFAULT,
  });
  const seen = new Set(campaignResults.map((m) => m.id));

  const graphMems = await expandWithGraph(db, message, queryEmbedding, seen);
  campaignResults.push(...(graphMems as typeof campaignResults));

  const recentMems = await getRecentMemories(db, 10);
  const combined = [...campaignResults];
  for (const m of recentMems) {
    if (!seen.has(m.id) && m.category !== "rules") {
      combined.push(m);
      seen.add(m.id);
    }
  }
  const campaignMemories = combined
    .filter((m) => m.category !== "rules")
    .map((m) => ({ content: m.content, category: m.category }));

  return { rulesMemories, campaignMemories };
}

function loadHistory(
  agent: Agent,
  historyMessages: Array<{ role: string; content: string }>,
): void {
  for (const msg of historyMessages) {
    if (msg.role === "user") {
      agent.state.messages = [
        ...agent.state.messages,
        { role: "user", content: msg.content, timestamp: Date.now() },
      ];
    } else if (msg.role === "assistant") {
      agent.state.messages = [
        ...agent.state.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
          api: "openrouter" as any,
          provider: "openrouter" as any,
          model: env.OPENROUTER_MODEL,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ];
    }
  }
}

function workerConfig(): WorkerModelConfig | null {
  return env.MEMORY_WORKER_MODEL
    ? {
        apiKey: env.OPENROUTER_API_KEY,
        model: env.MEMORY_WORKER_MODEL,
        baseUrl: env.OPENROUTER_BASE_URL,
        extraBody: { reasoning: { max_tokens: 1 } },
      }
    : null;
}

function runPostTurnPipeline(memoryManager: MemoryManager, conversationId: string): void {
  memoryManager
    .runObserver(conversationId)
    .then(async (ran: boolean) => {
      if (ran) {
        await memoryManager.promoteObservations(conversationId);
        return memoryManager.runReflector(conversationId);
      }
    })
    .catch((err: unknown) => console.error("Post-response observation failed:", err));
}

export async function processMessage(
  db: Kysely<Database>,
  sessionId: string,
  message: string,
  opts: ProcessMessageOpts = {},
): Promise<{ responseText: string }> {
  const session = await getSession(db, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const campaign = await getCampaign(db, session.campaign_id);
  if (!campaign) throw new Error(`Campaign not found: ${session.campaign_id}`);

  const conversationId = session.conversation_id;

  const memoryManager = new MemoryManager(db, {
    workerConfig: workerConfig(),
    embeddingModel: env.EMBEDDING_MODEL,
    apiKey: env.OPENROUTER_API_KEY,
  });

  const { observationsText, activeMessages, hasObservations } =
    await memoryManager.buildContext(conversationId);

  const historyMessages: Array<{ role: string; content: string }> = hasObservations
    ? activeMessages
    : await getMessages(db, conversationId, 20);

  const { rulesMemories, campaignMemories } = await recallMemoriesForQuery(db, message);

  const preamble = buildContextPreamble({
    timezone: env.TIMEZONE,
    mode: session.mode,
    campaignName: campaign.name,
    campaignSystem: campaign.system,
    observations: observationsText || undefined,
    rulesMemories: rulesMemories.length > 0 ? rulesMemories : undefined,
    campaignMemories: campaignMemories.length > 0 ? campaignMemories : undefined,
  });

  const model = getModel("openrouter", env.OPENROUTER_MODEL as Parameters<typeof getModel>[1]);
  const agent = new Agent({
    initialState: { systemPrompt: getSystemPrompt(), model },
  });

  loadHistory(agent, historyMessages);

  let responseText = "";
  const totalUsage = { input: 0, output: 0, cost: 0 };
  let hasUsage = false;

  agent.subscribe((event) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        responseText += delta;
        opts.onDelta?.(delta);
      }
    }
    if (event.type === "message_end") {
      const msg = event.message;
      if ("usage" in msg) {
        const u = msg.usage as Usage;
        totalUsage.input += u.input;
        totalUsage.output += u.output;
        totalUsage.cost += u.cost.total;
        hasUsage = true;
      }
    }
  });

  await saveMessage(db, {
    conversation_id: conversationId,
    role: "user",
    content: message,
  });

  await agent.prompt(preamble + message);
  await agent.waitForIdle();

  await saveMessage(db, {
    conversation_id: conversationId,
    role: "assistant",
    content: responseText,
  });

  if (hasUsage) {
    await trackUsage(db, {
      model: env.OPENROUTER_MODEL,
      input_tokens: totalUsage.input,
      output_tokens: totalUsage.output,
      cost_usd: totalUsage.cost,
      source: "loom",
    });
  }

  runPostTurnPipeline(memoryManager, conversationId);

  return { responseText };
}
