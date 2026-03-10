import { Type, type Static } from "@sinclair/typebox";
import type { TelegramContext } from "../../telegram/types.js";

const TelegramUnpinParams = Type.Object({
  telegram_message_id: Type.Optional(
    Type.Number({
      description: "The Telegram message ID to unpin. If omitted, unpins all messages in the chat.",
    }),
  ),
});

type TelegramUnpinInput = Static<typeof TelegramUnpinParams>;

export function createTelegramUnpinTool(telegram: TelegramContext) {
  return {
    name: "telegram_unpin",
    description: "Unpin a specific message or all pinned messages in the chat.",
    parameters: TelegramUnpinParams,
    execute: async (_toolCallId: string, args: TelegramUnpinInput) => {
      try {
        if (args.telegram_message_id) {
          await telegram.bot.api.unpinChatMessage(telegram.chatId, args.telegram_message_id);
          return {
            output: `Unpinned message [tg:${args.telegram_message_id}]`,
          };
        } else {
          await telegram.bot.api.unpinAllChatMessages(telegram.chatId);
          return { output: "Unpinned all messages" };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Failed to unpin: ${msg}` };
      }
    },
  };
}
