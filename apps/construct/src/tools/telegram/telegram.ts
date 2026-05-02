import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import { nanoid } from "nanoid";
import type { Database } from "../../db/schema.js";
import type { TelegramContext } from "../../telegram/types.js";
import { getOrCreateConversation, createPendingAsk } from "../../db/queries.js";

const ALLOWED_REACTIONS = [
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

const TelegramParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("react"),
      Type.Literal("reply"),
      Type.Literal("pin"),
      Type.Literal("unpin"),
      Type.Literal("get_pinned"),
      Type.Literal("ask"),
    ],
    {
      description:
        'Action: "react" (emoji reaction), "reply" (reply to message), "pin" (pin message), "unpin" (unpin message), "get_pinned" (get pinned message), "ask" (question with optional buttons)',
    },
  ),
  emoji: Type.Optional(
    Type.String({
      description: 'Emoji for "react" action. Must be a Telegram-allowed reaction emoji.',
    }),
  ),
  suppress_text: Type.Optional(
    Type.Boolean({
      description: 'For "react" action: skip text reply and only send the emoji reaction.',
    }),
  ),
  telegram_message_id: Type.Optional(
    Type.Number({
      description: 'Message ID for "reply", "pin", "unpin" actions.',
    }),
  ),
  silent: Type.Optional(
    Type.Boolean({
      description: 'For "pin" action: pin without notification. Defaults to true.',
    }),
  ),
  question: Type.Optional(
    Type.String({
      description: 'For "ask" action: the question to ask the user.',
    }),
  ),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description: 'For "ask" action: 2-4 button labels for the user to choose from.',
    }),
  ),
});

type TelegramInput = Static<typeof TelegramParams>;

export function createTelegramTool(db: Kysely<Database>, telegram: TelegramContext) {
  return {
    name: "telegram" as const,
    description:
      'Telegram interactions. Actions: "react" (emoji reaction), "reply" (reply to message), "pin" (pin message), "unpin" (unpin message(s)), "get_pinned" (view pinned message), "ask" (question with optional buttons).',
    parameters: TelegramParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as TelegramInput;

      switch (typed.action) {
        case "react": {
          if (!typed.emoji || !ALLOWED_SET.has(typed.emoji)) {
            return {
              output: `Invalid reaction emoji "${typed.emoji}". Use one of the allowed Telegram reaction emoji.`,
            };
          }
          telegram.sideEffects.reactToUser = typed.emoji;
          if (typed.suppress_text) {
            telegram.sideEffects.suppressText = true;
          }
          return {
            output: `Will react with ${typed.emoji}${typed.suppress_text ? " (no text reply)" : ""}`,
          };
        }

        case "reply": {
          if (!typed.telegram_message_id) {
            return { output: 'The "reply" action requires telegram_message_id.' };
          }
          telegram.sideEffects.replyToMessageId = typed.telegram_message_id;
          return {
            output: `Will reply to message [tg:${typed.telegram_message_id}]`,
          };
        }

        case "pin": {
          if (!typed.telegram_message_id) {
            return { output: 'The "pin" action requires telegram_message_id.' };
          }
          try {
            await telegram.bot.api.pinChatMessage(telegram.chatId, typed.telegram_message_id, {
              disable_notification: typed.silent ?? true,
            });
            return { output: `Pinned message [tg:${typed.telegram_message_id}]` };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { output: `Failed to pin message: ${msg}` };
          }
        }

        case "unpin": {
          try {
            if (typed.telegram_message_id) {
              await telegram.bot.api.unpinChatMessage(telegram.chatId, typed.telegram_message_id);
              return { output: `Unpinned message [tg:${typed.telegram_message_id}]` };
            } else {
              await telegram.bot.api.unpinAllChatMessages(telegram.chatId);
              return { output: "Unpinned all messages" };
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { output: `Failed to unpin: ${msg}` };
          }
        }

        case "get_pinned": {
          try {
            const chat = await telegram.bot.api.getChat(telegram.chatId);
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

        case "ask": {
          if (!typed.question) {
            return { output: 'The "ask" action requires a "question" parameter.' };
          }
          if (typed.options && (typed.options.length < 2 || typed.options.length > 4)) {
            return { output: "Options must have 2-4 items." };
          }

          const askId = nanoid(12);
          const conversationId = await getOrCreateConversation(db, "telegram", telegram.chatId);

          await createPendingAsk(db, {
            id: askId,
            conversationId,
            chatId: telegram.chatId,
            question: typed.question,
            options: typed.options,
          });

          telegram.sideEffects.askPayload = {
            askId,
            question: typed.question,
            options: typed.options,
          };
          telegram.sideEffects.suppressText = true;

          return {
            output: `Question sent to user. The user's response will appear in your next message. Do NOT answer the question yourself — wait for the user.`,
          };
        }

        default:
          return { output: `Unknown action: ${typed.action}` };
      }
    },
  };
}
