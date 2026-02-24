import { Type, type Static } from '@sinclair/typebox'
import type { TelegramContext } from '../../telegram/types.js'

const TelegramReactParams = Type.Object({
  emoji: Type.String({
    description: 'Emoji to react with (e.g. "👍", "❤️", "😂", "🔥", "👀")',
  }),
  suppress_text: Type.Optional(
    Type.Boolean({
      description:
        'If true, skip sending a text reply — the reaction is the entire response. Use for simple acknowledgments.',
    }),
  ),
})

type TelegramReactInput = Static<typeof TelegramReactParams>

export function createTelegramReactTool(telegram: TelegramContext) {
  return {
    name: 'telegram_react',
    description:
      'React to the user\'s message with an emoji. Use for lightweight acknowledgments instead of a text reply (set suppress_text=true), or combine with a text reply.',
    parameters: TelegramReactParams,
    execute: async (_toolCallId: string, args: TelegramReactInput) => {
      telegram.sideEffects.reactToUser = args.emoji
      if (args.suppress_text) {
        telegram.sideEffects.suppressText = true
      }
      return {
        output: `Will react with ${args.emoji}${args.suppress_text ? ' (no text reply)' : ''}`,
      }
    },
  }
}
