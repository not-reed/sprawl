import type { TelegramContext } from "./telegram/types.js";
import type { ConstructMemoryManager } from "./memory.js";
import type { PipelineQueue as PipelineQueueClass } from "@repo/cairn";

export interface AgentResponse {
  text: string;
  toolCalls: Array<{ id: string; name: string; args: unknown; result: string }>;
  usage?: { input: number; output: number; cost: number };
  messageId?: string;
}

export interface ProcessMessageOpts {
  source: "telegram" | "cli" | "scheduler";
  externalId: string | null;
  chatId?: string;
  telegram?: TelegramContext;
  replyContext?: string;
  incomingTelegramMessageId?: number;
  scheduleId?: string;
  pipelineQueue?: PipelineQueueClass;
}

export interface AssembledContext {
  conversationId: string;
  memoryManager: ConstructMemoryManager;
  historyMessages: Array<{
    role: string;
    content: string;
    created_at?: string;
    telegram_message_id?: number | null;
    tool_calls?: string | null;
  }>;
  preamble: string;
  queryEmbedding: number[] | undefined;
  selectedInstructions: string[];
  selectedInstructionIds: string[];
  recentMemories: Array<{ content: string; category: string; created_at: string }>;
  relevantMemories: Array<{
    content: string;
    category: string;
    score?: number;
    matchType?: string;
  }>;
  hasObservations: boolean;
  observationsText: string;
}

export interface TurnResult {
  responseText: string;
  toolCalls: AgentResponse["toolCalls"];
  totalUsage: { input: number; output: number; cost: number };
  hasUsage: boolean;
  toolErrors: Array<{ toolName: string; result: string }>;
  toolSuccesses: number;
}
