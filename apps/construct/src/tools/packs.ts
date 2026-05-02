import type { TSchema } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { TelegramContext } from "../telegram/types.js";
import type { MemoryManager } from "@repo/cairn";

import { createMemoryTool } from "./core/memory.js";
import { createScheduleTool } from "./core/schedule.js";
import { createSecretTool } from "./core/secret.js";
import { createReadTool } from "./core/read.js";
import { createEditTool } from "./core/edit.js";
import { createShellTool } from "./core/shell.js";
import { createSkillTool } from "./self/skill.js";
import { createWebTool } from "./web/web.js";
import { createTelegramTool } from "./telegram/telegram.js";

// --- Types ---

export interface InternalTool<T extends TSchema> {
  name: string;
  description: string;
  parameters: T;
  execute: (toolCallId: string, args: unknown) => Promise<{ output: string; details?: unknown }>;
}

export interface ToolContext {
  db: Kysely<Database>;
  chatId: string;
  apiKey: string;
  projectRoot: string;
  dbPath: string;
  timezone: string;
  tavilyApiKey?: string;
  logFile?: string;
  isDev: boolean;
  extensionsDir?: string;
  telegram?: TelegramContext;
  memoryManager?: MemoryManager;
  embeddingModel?: string;
}

// --- Create all built-in tools ---

/**
 * Create all 8 built-in tools. Null-filters tools that require unavailable
 * context (telegram without TelegramContext, web without tavilyApiKey).
 * No semantic pack selection — the LLM is smart enough to compose from
 * 8 powerful primitives. Dynamic extension tools are selected separately
 * via embedding similarity.
 */
export function createAllTools(ctx: ToolContext): InternalTool<TSchema>[] {
  const tools: InternalTool<TSchema>[] = [
    createMemoryTool(
      ctx.db,
      ctx.apiKey,
      ctx.memoryManager,
      ctx.embeddingModel,
    ) as InternalTool<TSchema>,
    createScheduleTool(
      ctx.db,
      ctx.chatId,
      ctx.timezone,
      ctx.apiKey,
      ctx.embeddingModel,
    ) as InternalTool<TSchema>,
    createSecretTool(ctx.db) as InternalTool<TSchema>,
    createSkillTool(ctx.db, ctx.apiKey, ctx.embeddingModel) as InternalTool<TSchema>,
    createReadTool(ctx.projectRoot, ctx.extensionsDir) as InternalTool<TSchema>,
    createEditTool(ctx.projectRoot, ctx.extensionsDir, ctx.db, ctx.chatId) as InternalTool<TSchema>,
    createShellTool(ctx.projectRoot) as InternalTool<TSchema>,
  ];

  // Web tool requires no special context beyond Tavily API key for search
  if (ctx.tavilyApiKey) {
    tools.push(createWebTool(ctx.tavilyApiKey) as InternalTool<TSchema>);
  }

  // Telegram requires an active Telegram session
  if (ctx.telegram) {
    tools.push(createTelegramTool(ctx.db, ctx.telegram) as InternalTool<TSchema>);
  }

  return tools;
}

// --- Backward compat: selectAndCreateTools replaces the old pack selection ---
// Extension tools still use semantic selection; this just instantiates built-ins.

// --- Re-export types needed by extensions ---

export interface ToolPack {
  name: string;
  description: string;
  alwaysLoad: boolean;
  factories: ToolFactory[];
}

export type ToolFactory = (ctx: ToolContext) => InternalTool<TSchema> | null;

// Backward compat alias
export { createAllTools as selectAndCreateTools };
