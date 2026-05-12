import { Bot } from "grammy";
import type { Kysely } from "kysely";
import { env } from "../env.js";
import { telegramLog } from "../logger.js";
import type { Database } from "../db/schema.js";
import type { PipelineQueue } from "@repo/cairn";
import { ChatQueueManager } from "./bot-queue.js";
import {
  type BotContext,
  processCallbackQuery,
  processNonTextMessage,
  processReaction,
  processTextMessage,
} from "./bot-handlers.js";

export function createBot(db: Kysely<Database>, pipelineQueue?: PipelineQueue) {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const ctx: BotContext = {
    bot,
    db,
    queueManager: new ChatQueueManager(),
    allowedIds: env.ALLOWED_TELEGRAM_IDS,
    pipelineQueue,
  };

  bot.on("message:text", (gctx) => processTextMessage(ctx, gctx));
  bot.on("callback_query:data", (gctx) => processCallbackQuery(ctx, gctx));
  bot.on("message_reaction", (gctx) => processReaction(ctx, gctx));
  bot.on("message", (gctx) => processNonTextMessage(ctx, gctx));

  bot.catch((err) => {
    telegramLog.error`Grammy error: ${err}`;
  });

  return bot;
}
