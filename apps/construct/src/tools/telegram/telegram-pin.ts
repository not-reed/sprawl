import { Type, type Static } from '@sinclair/typebox'
import type { TelegramContext } from '../../telegram/types.js'

const TelegramPinParams = Type.Object({
  telegram_message_id: Type.Number({
    description: 'The Telegram message ID to pin',
  }),
  silent: Type.Optional(
    Type.Boolean({
      description: 'If true, pin without sending a notification. Defaults to true.',
    }),
  ),
})

type TelegramPinInput = Static<typeof TelegramPinParams>

export function createTelegramPinTool(telegram: TelegramContext) {
  return {
    name: 'telegram_pin',
    description: 'Pin a message in the chat by its Telegram message ID.',
    parameters: TelegramPinParams,
    execute: async (_toolCallId: string, args: TelegramPinInput) => {
      try {
        await telegram.bot.api.pinChatMessage(
          telegram.chatId,
          args.telegram_message_id,
          { disable_notification: args.silent ?? true },
        )
        return {
          output: `Pinned message [tg:${args.telegram_message_id}]`,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `Failed to pin message: ${msg}` }
      }
    },
  }
}
