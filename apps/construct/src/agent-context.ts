import type { Kysely } from "kysely";
import {
  generateEmbedding,
  cosineSimilarity,
  SIMILARITY,
  type WorkerModelConfig,
} from "@repo/cairn";
import { env } from "./env.js";
import { agentLog } from "./logger.js";
import { startActiveSpan } from "./tracing.js";
import type { Database } from "./db/schema.js";
import {
  getOrCreateConversation,
  getRecentMessages,
  getRecentMemories,
  recallMemories,
} from "./db/queries.js";
import {
  ConstructMemoryManager,
  CONSTRUCT_OBSERVER_PROMPT,
  CONSTRUCT_REFLECTOR_PROMPT,
} from "./memory.js";
import { detectConflicts } from "./skills/discovery.js";
import { selectAndRetrieveSkillInstructions } from "./extensions/index.js";
import { buildContextPreamble } from "./system-prompt.js";
import type { AssembledContext, ProcessMessageOpts } from "./agent-types.js";

interface MemoryRecallResult {
  queryEmbedding: number[] | undefined;
  recentMemories: Array<{
    id: string;
    content: string;
    category: string;
    created_at: string;
    embedding?: Buffer | string | null;
  }>;
  relevantMemories: Array<{
    content: string;
    category: string;
    score?: number;
    matchType?: string;
  }>;
}

async function retrieveMemoriesForQuery(
  db: Kysely<Database>,
  message: string,
  recentMemoriesRaw: Awaited<ReturnType<typeof getRecentMemories>>,
): Promise<MemoryRecallResult> {
  let queryEmbedding: number[] | undefined;
  let recentMemories: typeof recentMemoriesRaw = [];
  let relevantMemories: MemoryRecallResult["relevantMemories"] = [];

  try {
    queryEmbedding = await generateEmbedding(env.OPENROUTER_API_KEY, message, env.EMBEDDING_MODEL);

    recentMemories = recentMemoriesRaw.filter((m) => {
      if (!m.embedding) return false;
      try {
        const sim = cosineSimilarity(queryEmbedding!, JSON.parse(m.embedding.toString()));
        return sim >= SIMILARITY.RECENT_MEMORY_MIN;
      } catch {
        return false;
      }
    });

    const results = await recallMemories(db, message, {
      limit: 5,
      queryEmbedding,
      similarityThreshold: SIMILARITY.RECALL_STRICT,
    });
    const recentIds = new Set(recentMemories.map((m) => m.id));
    relevantMemories = results
      .filter((m) => !recentIds.has(m.id))
      .map((m) => ({
        content: m.content,
        category: m.category,
        score: m.score,
        matchType: m.matchType,
      }));
  } catch (err) {
    agentLog.warning`Embedding generation failed, falling back to unfiltered recent memories: ${err}`;
    recentMemories = recentMemoriesRaw;
  }

  return { queryEmbedding, recentMemories, relevantMemories };
}

async function logInstructionConflicts(
  db: Kysely<Database>,
  selectedInstructions: string[],
): Promise<void> {
  if (selectedInstructions.length <= 1) return;
  try {
    const conflicts = await detectConflicts(db, env.OPENROUTER_API_KEY, env.EMBEDDING_MODEL);
    if (conflicts.length > 0) {
      agentLog.warning`Conflicting instructions detected in this context: ${conflicts.length} conflict(s)`;
      for (const conflict of conflicts) {
        agentLog.warning`- ${conflict.conflictType}: "${conflict.instructionA.text}" vs "${conflict.instructionB.text}"`;
      }
    }
  } catch (err) {
    agentLog.debug`Failed to check for instruction conflicts: ${err}`;
  }
}

export interface AssembleContextArgs {
  db: Kysely<Database>;
  message: string;
  opts: ProcessMessageOpts;
  rootSpan: ReturnType<typeof startActiveSpan>;
  workerConfig: WorkerModelConfig | null;
  isDev: boolean;
}

export async function assembleContext(args: AssembleContextArgs): Promise<AssembledContext> {
  const { db, message, opts, rootSpan, workerConfig, isDev } = args;
  const conversationId = await getOrCreateConversation(db, opts.source, opts.externalId);
  rootSpan.setAttribute("conversation_id", conversationId);
  if (opts.scheduleId) rootSpan.setAttribute("schedule_id", opts.scheduleId);

  const contextSpan = startActiveSpan({ name: "context_assembly" });

  const memoryManager = new ConstructMemoryManager(db, {
    workerConfig,
    embeddingModel: env.EMBEDDING_MODEL,
    apiKey: env.OPENROUTER_API_KEY,
    observerPrompt: CONSTRUCT_OBSERVER_PROMPT,
    reflectorPrompt: CONSTRUCT_REFLECTOR_PROMPT,
    logger: agentLog,
  });

  const { observationsText, activeMessages, hasObservations, evictedObservations } =
    await memoryManager.buildContext(conversationId);

  let historyMessages: typeof activeMessages;
  if (hasObservations) {
    historyMessages = activeMessages;
    agentLog.debug`Context: ${observationsText.split("\n").length} observations, ${activeMessages.length} active messages${evictedObservations > 0 ? `, ${evictedObservations} evicted` : ""}`;
  } else {
    historyMessages = await getRecentMessages(db, conversationId, 20);
    agentLog.debug`Loaded ${historyMessages.length} history messages (no observations)`;
  }

  const recentMemoriesRaw = await getRecentMemories(db, 10);
  const { queryEmbedding, recentMemories, relevantMemories } = await retrieveMemoriesForQuery(
    db,
    message,
    recentMemoriesRaw,
  );

  agentLog.debug`Context: ${recentMemories.length} recent memories, ${relevantMemories.length} relevant memories`;

  const { formatted: selectedInstructions, instructionIds: selectedInstructionIds } =
    await selectAndRetrieveSkillInstructions(queryEmbedding);

  await logInstructionConflicts(db, selectedInstructions);

  contextSpan.setAttributes({
    has_observations: hasObservations,
    active_messages: activeMessages.length,
    recent_memories: recentMemories.length,
    relevant_memories: relevantMemories.length,
    skill_instructions: selectedInstructions.length,
  });
  contextSpan.end();

  const recentMemoriesForPreamble = recentMemories.map((m) => ({
    content: m.content,
    category: m.category,
    created_at: m.created_at,
  }));

  const preamble = buildContextPreamble({
    timezone: env.TIMEZONE,
    source: opts.source,
    dev: isDev,
    observations: observationsText || undefined,
    recentMemories: recentMemoriesForPreamble,
    relevantMemories,
    skillInstructions: selectedInstructions,
    replyContext: opts.replyContext,
  });

  return {
    conversationId,
    memoryManager,
    historyMessages,
    preamble,
    queryEmbedding,
    selectedInstructions,
    selectedInstructionIds,
    recentMemories: recentMemoriesForPreamble,
    relevantMemories,
    hasObservations,
    observationsText: observationsText || "",
  };
}
