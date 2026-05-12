import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { TelegramContext } from "../../telegram/types.js";
import {
  type HandlerResult,
  type TelegramArgs,
  type TelegramToolContext,
  handleAsk,
  handleGetPinned,
  handlePin,
  handleReact,
  handleReply,
  handleUnpin,
} from "./telegram-handlers.js";

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
    Type.Number({ description: 'Message ID for "reply", "pin", "unpin" actions.' }),
  ),
  silent: Type.Optional(
    Type.Boolean({ description: 'For "pin" action: pin without notification. Defaults to true.' }),
  ),
  question: Type.Optional(
    Type.String({ description: 'For "ask" action: the question to ask the user.' }),
  ),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description: 'For "ask" action: 2-4 button labels for the user to choose from.',
    }),
  ),
});

type TelegramInput = Static<typeof TelegramParams>;

const handlers: Record<
  TelegramInput["action"],
  (ctx: TelegramToolContext, args: TelegramArgs) => HandlerResult | Promise<HandlerResult>
> = {
  react: handleReact,
  reply: handleReply,
  pin: handlePin,
  unpin: handleUnpin,
  get_pinned: (ctx) => handleGetPinned(ctx),
  ask: handleAsk,
};

export function createTelegramTool(db: Kysely<Database>, telegram: TelegramContext) {
  const ctx: TelegramToolContext = { db, telegram };

  return {
    name: "telegram" as const,
    description:
      'Telegram interactions. Actions: "react" (emoji reaction), "reply" (reply to message), "pin" (pin message), "unpin" (unpin message(s)), "get_pinned" (view pinned message), "ask" (question with optional buttons).',
    parameters: TelegramParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as TelegramInput;
      const handler = handlers[typed.action];
      if (!handler) return { output: `Unknown action: ${typed.action}` };
      return handler(ctx, typed);
    },
  };
}
