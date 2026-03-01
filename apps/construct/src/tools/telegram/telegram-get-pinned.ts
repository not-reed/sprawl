import { Type } from '@sinclair/typebox'
import type { TelegramContext } from '../../telegram/types.js'

const TelegramGetPinnedParams = Type.Object({})

export function createTelegramGetPinnedTool(telegram: TelegramContext) {
  return {
    name: 'telegram_get_pinned',
    description: 'Get the currently pinned message in the chat.',
    parameters: TelegramGetPinnedParams,
    execute: async () => {
      try {
        const chat = await telegram.bot.api.getChat(telegram.chatId)
        if ('pinned_message' in chat && chat.pinned_message) {
          const pinned = chat.pinned_message
          const text =
            'text' in pinned && pinned.text
              ? pinned.text.slice(0, 200)
              : '(non-text message)'
          return {
            output: `Pinned message [tg:${pinned.message_id}]: "${text}"`,
          }
        }
        return { output: 'No message is currently pinned' }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `Failed to get pinned message: ${msg}` }
      }
    },
  }
}
