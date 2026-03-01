import { Type, type Static } from '@sinclair/typebox'
import type { TelegramContext } from '../../telegram/types.js'

// Telegram Bot API allowed reaction emoji (from @grammyjs/types ReactionTypeEmoji)
const ALLOWED_REACTIONS = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢',
  '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳',
  '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓',
  '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈',
  '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
  '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
] as const

const ALLOWED_SET = new Set<string>(ALLOWED_REACTIONS)

const TelegramReactParams = Type.Object({
  emoji: Type.String({
    description: 'Emoji to react with. Must be one of: 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡',
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
      if (!ALLOWED_SET.has(args.emoji)) {
        return {
          output: `Invalid reaction emoji "${args.emoji}". Use one of the allowed Telegram reaction emoji.`,
        }
      }
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
