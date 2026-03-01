import { Type, type Static } from '@sinclair/typebox'
import type { TelegramContext } from '../../telegram/types.js'

const TelegramReplyToParams = Type.Object({
  telegram_message_id: Type.Number({
    description:
      'The Telegram message ID to reply to (from [tg:ID] prefix in conversation history)',
  }),
})

type TelegramReplyToInput = Static<typeof TelegramReplyToParams>

export function createTelegramReplyToTool(telegram: TelegramContext) {
  return {
    name: 'telegram_reply_to',
    description:
      'Mark the response to reply to a specific message by its Telegram ID (shown as [tg:ID] in conversation history). Use when referencing or responding to a specific older message.',
    parameters: TelegramReplyToParams,
    execute: async (_toolCallId: string, args: TelegramReplyToInput) => {
      telegram.sideEffects.replyToMessageId = args.telegram_message_id
      return {
        output: `Will reply to message [tg:${args.telegram_message_id}]`,
      }
    },
  }
}
