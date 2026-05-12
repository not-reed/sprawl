import { Bot, InlineKeyboard } from "grammy";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { updateTelegramMessageId } from "../db/queries.js";
import { telegramLog } from "../logger.js";
import { markdownToTelegramHtml } from "./format.js";
import type { AskPayload, TelegramSideEffects } from "./types.js";

const MAX_TELEGRAM_LEN = 4000;

export async function sendReply(
  db: Kysely<Database>,
  ctx: { reply: (...args: any[]) => Promise<any> },
  text: string,
  sideEffects: TelegramSideEffects,
  assistantMessageId?: string,
): Promise<void> {
  const replyParams = sideEffects.replyToMessageId
    ? { reply_parameters: { message_id: sideEffects.replyToMessageId } }
    : {};

  const send = async (chunk: string, isFirst: boolean) => {
    const base = isFirst ? replyParams : {};
    try {
      return await ctx.reply(markdownToTelegramHtml(chunk), {
        ...base,
        parse_mode: "HTML" as const,
      });
    } catch {
      return await ctx.reply(chunk, base);
    }
  };

  let sentMessage: any;
  if (text.length <= MAX_TELEGRAM_LEN) {
    sentMessage = await send(text, true);
  } else {
    let remaining = text;
    let isFirst = true;
    while (remaining.length > MAX_TELEGRAM_LEN) {
      // Try to break at a newline first, then a space, within the last 200 chars of the chunk window.
      let breakIdx = remaining.lastIndexOf("\n", MAX_TELEGRAM_LEN);
      if (breakIdx <= MAX_TELEGRAM_LEN - 200) {
        const spaceIdx = remaining.lastIndexOf(" ", MAX_TELEGRAM_LEN);
        if (spaceIdx > MAX_TELEGRAM_LEN - 200) {
          breakIdx = spaceIdx;
        }
      }
      if (breakIdx <= 0) breakIdx = MAX_TELEGRAM_LEN;

      const chunk = remaining.slice(0, breakIdx);
      remaining = remaining.slice(breakIdx).trimStart();

      const msg = await send(chunk, isFirst);
      if (isFirst) sentMessage = msg;
      isFirst = false;
    }
    if (remaining.length > 0) {
      await send(remaining, isFirst);
    }
  }

  if (sentMessage?.message_id && assistantMessageId) {
    await updateTelegramMessageId(db, assistantMessageId, sentMessage.message_id).catch(
      (err) => telegramLog.error`Failed to track sent message ID: ${err}`,
    );
  }
}

export async function sendAskMessage(bot: Bot, chatId: string, payload: AskPayload) {
  const keyboard = new InlineKeyboard();
  if (payload.options) {
    for (let i = 0; i < payload.options.length; i++) {
      keyboard.text(payload.options[i]!, `ask:${payload.askId}:${i}`);
      if (i < payload.options.length - 1) keyboard.row();
    }
  }

  const sendOpts = payload.options ? { reply_markup: keyboard } : {};

  try {
    return await bot.api.sendMessage(chatId, markdownToTelegramHtml(payload.question), {
      ...sendOpts,
      parse_mode: "HTML" as const,
    });
  } catch {
    return await bot.api.sendMessage(chatId, payload.question, sendOpts);
  }
}
