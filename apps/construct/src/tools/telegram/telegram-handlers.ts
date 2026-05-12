import type { Kysely } from "kysely";
import { nanoid } from "nanoid";
import type { Database } from "../../db/schema.js";
import type { TelegramContext } from "../../telegram/types.js";
import { getOrCreateConversation, createPendingAsk } from "../../db/queries.js";

export const ALLOWED_REACTIONS = [
  "👍",
  "👎",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
] as const;

const ALLOWED_SET = new Set<string>(ALLOWED_REACTIONS);

export interface TelegramToolContext {
  db: Kysely<Database>;
  telegram: TelegramContext;
}

export interface TelegramArgs {
  action: string;
  emoji?: string;
  suppress_text?: boolean;
  telegram_message_id?: number;
  silent?: boolean;
  question?: string;
  options?: string[];
}

export interface HandlerResult {
  output: string;
  details?: unknown;
}

export function handleReact(ctx: TelegramToolContext, args: TelegramArgs): HandlerResult {
  if (!args.emoji || !ALLOWED_SET.has(args.emoji)) {
    return {
      output: `Invalid reaction emoji "${args.emoji}". Use one of the allowed Telegram reaction emoji.`,
    };
  }
  ctx.telegram.sideEffects.reactToUser = args.emoji;
  if (args.suppress_text) ctx.telegram.sideEffects.suppressText = true;
  return {
    output: `Will react with ${args.emoji}${args.suppress_text ? " (no text reply)" : ""}`,
  };
}

export function handleReply(ctx: TelegramToolContext, args: TelegramArgs): HandlerResult {
  if (!args.telegram_message_id) {
    return { output: 'The "reply" action requires telegram_message_id.' };
  }
  ctx.telegram.sideEffects.replyToMessageId = args.telegram_message_id;
  return { output: `Will reply to message [tg:${args.telegram_message_id}]` };
}

export async function handlePin(
  ctx: TelegramToolContext,
  args: TelegramArgs,
): Promise<HandlerResult> {
  if (!args.telegram_message_id) {
    return { output: 'The "pin" action requires telegram_message_id.' };
  }
  try {
    await ctx.telegram.bot.api.pinChatMessage(ctx.telegram.chatId, args.telegram_message_id, {
      disable_notification: args.silent ?? true,
    });
    return { output: `Pinned message [tg:${args.telegram_message_id}]` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Failed to pin message: ${msg}` };
  }
}

export async function handleUnpin(
  ctx: TelegramToolContext,
  args: TelegramArgs,
): Promise<HandlerResult> {
  try {
    if (args.telegram_message_id) {
      await ctx.telegram.bot.api.unpinChatMessage(ctx.telegram.chatId, args.telegram_message_id);
      return { output: `Unpinned message [tg:${args.telegram_message_id}]` };
    }
    await ctx.telegram.bot.api.unpinAllChatMessages(ctx.telegram.chatId);
    return { output: "Unpinned all messages" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Failed to unpin: ${msg}` };
  }
}

export async function handleGetPinned(ctx: TelegramToolContext): Promise<HandlerResult> {
  try {
    const chat = await ctx.telegram.bot.api.getChat(ctx.telegram.chatId);
    if ("pinned_message" in chat && chat.pinned_message) {
      const pinned = chat.pinned_message;
      const text =
        "text" in pinned && pinned.text ? pinned.text.slice(0, 200) : "(non-text message)";
      return {
        output: `Pinned message [tg:${pinned.message_id}]: ${text}`,
        details: { messageId: pinned.message_id, text },
      };
    }
    return { output: "No message is currently pinned." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Failed to get pinned message: ${msg}` };
  }
}

export async function handleAsk(
  ctx: TelegramToolContext,
  args: TelegramArgs,
): Promise<HandlerResult> {
  if (!args.question) return { output: 'The "ask" action requires a "question" parameter.' };
  if (args.options && (args.options.length < 2 || args.options.length > 4)) {
    return { output: "Options must have 2-4 items." };
  }

  const askId = nanoid(12);
  const conversationId = await getOrCreateConversation(ctx.db, "telegram", ctx.telegram.chatId);

  await createPendingAsk(ctx.db, {
    id: askId,
    conversationId,
    chatId: ctx.telegram.chatId,
    question: args.question,
    options: args.options,
  });

  ctx.telegram.sideEffects.askPayload = {
    askId,
    question: args.question,
    options: args.options,
  };
  ctx.telegram.sideEffects.suppressText = true;

  return {
    output: `Question sent to user. The user's response will appear in your next message. Do NOT answer the question yourself — wait for the user.`,
  };
}
