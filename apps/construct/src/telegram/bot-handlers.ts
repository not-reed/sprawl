import { Bot, InlineKeyboard } from "grammy";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { processMessage } from "../agent.js";
import { telegramLog } from "../logger.js";
import {
  getOrCreateConversation,
  getMessageByTelegramId,
  getPendingAsk,
  getPendingAskById,
  resolvePendingAsk,
  setPendingAskTelegramId,
  getSetting,
  setSetting,
  deleteSetting,
} from "../db/queries.js";
import type { TelegramSideEffects, TelegramContext } from "./types.js";
import { markdownToTelegramHtml } from "./format.js";
import type { PipelineQueue } from "@repo/cairn";
import { ChatQueueManager } from "./bot-queue.js";
import { sendAskMessage, sendReply } from "./bot-send.js";

const ASK_EXPIRY_MS = 10 * 60 * 1000;
const TYPING_INTERVAL_MS = 4000;

export interface BotContext {
  bot: Bot;
  db: Kysely<Database>;
  queueManager: ChatQueueManager;
  allowedIds: string[];
  pipelineQueue?: PipelineQueue;
}

export function isAuthorized(allowedIds: string[], userId: string): boolean {
  return allowedIds.length === 0 || allowedIds.includes(userId);
}

function startTypingLoop(bot: Bot, chatId: string): { stop: () => void } {
  const sendTyping = () =>
    bot.api.sendChatAction(chatId, "typing").catch((err) => {
      telegramLog.error`Typing indicator failed: ${err}`;
    });
  void sendTyping();
  const id = setInterval(sendTyping, TYPING_INTERVAL_MS);
  return { stop: () => clearInterval(id) };
}

async function applyReactionSideEffect(
  bot: Bot,
  chatId: string,
  messageId: number,
  emoji: string | undefined,
): Promise<void> {
  if (!emoji) return;
  try {
    await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: emoji as any }]);
  } catch (err) {
    telegramLog.error`Failed to react: ${err}`;
  }
}

async function applyAskSideEffect(
  bot: Bot,
  db: Kysely<Database>,
  chatId: string,
  sideEffects: TelegramSideEffects,
): Promise<void> {
  if (!sideEffects.askPayload) return;
  try {
    const sent = await sendAskMessage(bot, chatId, sideEffects.askPayload);
    await setPendingAskTelegramId(db, sideEffects.askPayload.askId, sent.message_id);
  } catch (err) {
    telegramLog.error`Failed to send ask message: ${err}`;
  }
}

async function maybeShowSkillNudge(bot: Bot, db: Kysely<Database>, chatId: string): Promise<void> {
  try {
    const nudgePayload = await getSetting(db, `skill_nudge:${chatId}`);
    if (!nudgePayload) return;

    await deleteSetting(db, `skill_nudge:${chatId}`);
    const candidate = JSON.parse(nudgePayload) as {
      name: string;
      description: string;
      body: string;
    };
    await setSetting(db, `skill_nudge_pending:${chatId}`, nudgePayload);
    const keyboard = new InlineKeyboard()
      .text("Save it", `skillnudge:save:${chatId}`)
      .text("Ignore", `skillnudge:ignore:${chatId}`);
    await bot.api
      .sendMessage(
        chatId,
        markdownToTelegramHtml(
          `I noticed a reusable pattern — want me to save it as a skill?\n\n**${candidate.name}**\n${candidate.description}`,
        ),
        { reply_markup: keyboard, parse_mode: "HTML" as const },
      )
      .catch((err) => telegramLog.error`Failed to send skill nudge: ${err}`);
  } catch (err) {
    telegramLog.error`Error checking skill nudge: ${err}`;
  }
}

async function resolvePendingAskInline(
  bot: Bot,
  db: Kysely<Database>,
  chatId: string,
  rawText: string,
): Promise<string> {
  const pendingAsk = await getPendingAsk(db, chatId);
  if (!pendingAsk) return rawText;

  await resolvePendingAsk(db, pendingAsk.id, rawText);
  const messageText = `[You had asked: "${pendingAsk.question}". User's next message:]\n${rawText}`;

  if (pendingAsk.telegram_message_id) {
    try {
      await bot.api.editMessageText(
        chatId,
        pendingAsk.telegram_message_id,
        `${pendingAsk.question}\n\n<i>Answered</i>`,
        { parse_mode: "HTML", reply_markup: undefined },
      );
    } catch (err) {
      telegramLog.error`Failed to edit ask message: ${err}`;
    }
  }
  return messageText;
}

export async function processTextMessage(ctx: BotContext, gctx: any): Promise<void> {
  const userId = String(gctx.from.id);
  const chatId = String(gctx.chat.id);

  if (!isAuthorized(ctx.allowedIds, userId)) {
    telegramLog.warning`Unauthorized message from user ${userId}`;
    await gctx.reply("Unauthorized.");
    return;
  }

  telegramLog.info`Message from user ${userId} (chat ${chatId}): ${gctx.message.text.slice(0, 100)}`;

  ctx.queueManager.enqueue(chatId, async () => {
    const typing = startTypingLoop(ctx.bot, chatId);
    try {
      const messageText = await resolvePendingAskInline(ctx.bot, ctx.db, chatId, gctx.message.text);

      const sideEffects: TelegramSideEffects = {};
      const telegramCtx: TelegramContext = {
        bot: ctx.bot,
        chatId,
        incomingMessageId: gctx.message.message_id,
        sideEffects,
      };

      const replyContext = gctx.message.reply_to_message?.text ?? undefined;

      const response = await processMessage(ctx.db, messageText, {
        source: "telegram",
        externalId: chatId,
        chatId,
        telegram: telegramCtx,
        replyContext,
        incomingTelegramMessageId: gctx.message.message_id,
        pipelineQueue: ctx.pipelineQueue,
      });

      await applyReactionSideEffect(
        ctx.bot,
        chatId,
        gctx.message.message_id,
        sideEffects.reactToUser,
      );
      await applyAskSideEffect(ctx.bot, ctx.db, chatId, sideEffects);

      if (!sideEffects.replyToMessageId && ctx.queueManager.shouldReplyTo(chatId)) {
        sideEffects.replyToMessageId = gctx.message.message_id;
      }

      if (!sideEffects.suppressText && response.text) {
        await sendReply(ctx.db, gctx, response.text, sideEffects, response.messageId);
      }

      await maybeShowSkillNudge(ctx.bot, ctx.db, chatId);

      telegramLog.info`Reply sent to chat ${chatId} (${response.text.length} chars, suppress=${!!sideEffects.suppressText})`;
    } catch (err) {
      telegramLog.error`Error processing message: ${err}`;
      await gctx.reply("Something went wrong. Check the logs.");
    } finally {
      typing.stop();
    }
  });
}

async function handleSkillNudgeCallback(
  ctx: BotContext,
  gctx: any,
  action: string,
  nudgeChatId: string,
): Promise<void> {
  await gctx.answerCallbackQuery({ text: action === "save" ? "Creating skill..." : "Got it." });

  const stored = await getSetting(ctx.db, `skill_nudge_pending:${nudgeChatId}`);
  if (!stored) {
    await gctx.editMessageText("This suggestion has expired.").catch(() => {});
    return;
  }

  await deleteSetting(ctx.db, `skill_nudge_pending:${nudgeChatId}`);
  const candidate = JSON.parse(stored) as { name: string; description: string; body: string };

  if (action === "ignore") {
    const normalizedName = candidate.name.toLowerCase().replace(/[^a-z0-9]/g, "-");
    await setSetting(ctx.db, `ignored_skill:${normalizedName}`, new Date().toISOString());
    await gctx.editMessageText("Got it, skipping that one.").catch(() => {});
    return;
  }

  await gctx
    .editMessageText(markdownToTelegramHtml(`Creating skill **${candidate.name}**...`), {
      parse_mode: "HTML",
    })
    .catch(() => {});

  ctx.queueManager.enqueue(nudgeChatId, async () => {
    const typing = startTypingLoop(ctx.bot, nudgeChatId);
    try {
      const instruction = [
        `Use the skill_create tool to save this skill now. Do not ask for confirmation.`,
        `Name: "${candidate.name}"`,
        `Description: "${candidate.description}"`,
        `Body:\n${candidate.body}`,
      ].join("\n");

      const response = await processMessage(ctx.db, instruction, {
        source: "telegram",
        externalId: nudgeChatId,
        chatId: nudgeChatId,
        pipelineQueue: ctx.pipelineQueue,
      });

      if (response.text.trim()) {
        await ctx.bot.api
          .sendMessage(nudgeChatId, markdownToTelegramHtml(response.text), {
            parse_mode: "HTML" as const,
          })
          .catch(async () => {
            await ctx.bot.api.sendMessage(nudgeChatId, response.text);
          });
      }
    } catch (err) {
      telegramLog.error`Error creating skill from nudge: ${err}`;
      await ctx.bot.api.sendMessage(nudgeChatId, "Failed to create skill. Check the logs.");
    } finally {
      typing.stop();
    }
  });
}

async function handleAskCallback(
  ctx: BotContext,
  gctx: any,
  askId: string,
  optionIndex: number,
): Promise<void> {
  const chatId = String(gctx.chat!.id);

  const ask = await getPendingAskById(ctx.db, askId);
  if (!ask || ask.resolved_at) {
    await gctx.answerCallbackQuery({ text: "This question has expired." });
    return;
  }

  const createdAt = new Date(ask.created_at + "Z").getTime();
  if (Date.now() - createdAt > ASK_EXPIRY_MS) {
    await gctx.answerCallbackQuery({ text: "This question has expired." });
    return;
  }

  const options: string[] = ask.options ? JSON.parse(ask.options) : [];
  const selectedOption = options[optionIndex];
  if (!selectedOption) {
    await gctx.answerCallbackQuery({ text: "Invalid option." });
    return;
  }

  await resolvePendingAsk(ctx.db, askId, selectedOption);
  await gctx.answerCallbackQuery({ text: `Selected: ${selectedOption}` });

  try {
    await gctx.editMessageText(`${ask.question}\n\n<b>${selectedOption}</b>`, {
      parse_mode: "HTML",
      reply_markup: undefined,
    });
  } catch (err) {
    telegramLog.error`Failed to edit ask message after callback: ${err}`;
  }

  ctx.queueManager.enqueue(chatId, async () => {
    const typing = startTypingLoop(ctx.bot, chatId);
    try {
      const syntheticMessage = `[User answered your question "${ask.question}": ${selectedOption}]`;

      const sideEffects: TelegramSideEffects = {};
      const telegramCtx: TelegramContext = {
        bot: ctx.bot,
        chatId,
        incomingMessageId: gctx.callbackQuery.message?.message_id ?? 0,
        sideEffects,
      };

      const response = await processMessage(ctx.db, syntheticMessage, {
        source: "telegram",
        externalId: chatId,
        chatId,
        telegram: telegramCtx,
        pipelineQueue: ctx.pipelineQueue,
      });

      const askMsgId = gctx.callbackQuery.message?.message_id;
      if (askMsgId) {
        await applyReactionSideEffect(ctx.bot, chatId, askMsgId, sideEffects.reactToUser);
      }
      await applyAskSideEffect(ctx.bot, ctx.db, chatId, sideEffects);

      if (!sideEffects.suppressText && response.text.trim()) {
        await sendReply(
          ctx.db,
          { reply: (text: string, extra?: any) => ctx.bot.api.sendMessage(chatId, text, extra) },
          response.text,
          sideEffects,
          response.messageId,
        );
      }
    } catch (err) {
      telegramLog.error`Error processing callback query: ${err}`;
    } finally {
      typing.stop();
    }
  });
}

export async function processCallbackQuery(ctx: BotContext, gctx: any): Promise<void> {
  const userId = String(gctx.from.id);
  if (!isAuthorized(ctx.allowedIds, userId)) {
    await gctx.answerCallbackQuery({ text: "Unauthorized." });
    return;
  }

  const data = gctx.callbackQuery.data;

  const nudgeMatch = data.match(/^skillnudge:(save|ignore):(.+)$/);
  if (nudgeMatch) {
    const [, action, nudgeChatId] = nudgeMatch;
    await handleSkillNudgeCallback(ctx, gctx, action, nudgeChatId);
    return;
  }

  const match = data.match(/^ask:([^:]+):(\d+)$/);
  if (!match) {
    await gctx.answerCallbackQuery();
    return;
  }
  const [, askId, indexStr] = match;
  await handleAskCallback(ctx, gctx, askId, parseInt(indexStr, 10));
}

export async function processReaction(ctx: BotContext, gctx: any): Promise<void> {
  const userId = String(gctx.from!.id);
  const chatId = String(gctx.chat.id);

  if (!isAuthorized(ctx.allowedIds, userId)) return;

  const update = gctx.messageReaction;
  const newEmojis = update.new_reaction
    .filter((r: any) => r.type === "emoji")
    .map((r: any) => r.emoji);

  if (newEmojis.length === 0) return;

  const telegramMsgId = update.message_id;
  const emojiStr = newEmojis.join("");

  telegramLog.info`Reaction from user ${userId}: ${emojiStr} on message ${telegramMsgId}`;

  ctx.queueManager.enqueue(chatId, async () => {
    const conversationId = await getOrCreateConversation(ctx.db, "telegram", chatId);
    const message = await getMessageByTelegramId(ctx.db, conversationId, telegramMsgId);
    const whose = message?.role === "assistant" ? "your" : "their";
    const preview = message?.content?.slice(0, 100) ?? "(unknown message)";

    const syntheticMessage = `[User reacted with ${emojiStr} to ${whose} message: "${preview}"]`;

    try {
      const sideEffects: TelegramSideEffects = {};
      const telegramCtx: TelegramContext = {
        bot: ctx.bot,
        chatId,
        incomingMessageId: telegramMsgId,
        sideEffects,
      };

      const response = await processMessage(ctx.db, syntheticMessage, {
        source: "telegram",
        externalId: chatId,
        chatId,
        telegram: telegramCtx,
        pipelineQueue: ctx.pipelineQueue,
      });

      await applyReactionSideEffect(ctx.bot, chatId, telegramMsgId, sideEffects.reactToUser);

      if (!sideEffects.suppressText && response.text.trim()) {
        await sendReply(
          ctx.db,
          { reply: (text: string, extra?: any) => ctx.bot.api.sendMessage(chatId, text, extra) },
          response.text,
          sideEffects,
          response.messageId,
        );
      }
    } catch (err) {
      telegramLog.error`Error processing reaction: ${err}`;
    }
  });
}

export async function processNonTextMessage(ctx: BotContext, gctx: any): Promise<void> {
  if (!isAuthorized(ctx.allowedIds, String(gctx.from?.id))) return;

  const m = gctx.message;
  const isService =
    m.pinned_message ||
    m.new_chat_members ||
    m.left_chat_member ||
    m.new_chat_title ||
    m.new_chat_photo ||
    m.delete_chat_photo ||
    m.group_chat_created ||
    m.supergroup_chat_created ||
    m.migrate_to_chat_id ||
    m.migrate_from_chat_id;

  if (isService) return;
  await gctx.reply("I can only process text messages for now.");
}
