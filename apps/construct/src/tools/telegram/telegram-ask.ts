import { Type, type Static } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import type { Database } from '../../db/schema.js'
import type { TelegramContext } from '../../telegram/types.js'
import { getOrCreateConversation, createPendingAsk } from '../../db/queries.js'

const TelegramAskParams = Type.Object({
  question: Type.String({
    description: 'The question to ask the user.',
  }),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Optional button labels (2-4 items). If omitted, user replies with free-form text.',
      minItems: 2,
      maxItems: 4,
    }),
  ),
})

type TelegramAskInput = Static<typeof TelegramAskParams>

export function createTelegramAskTool(db: Kysely<Database>, telegram: TelegramContext) {
  return {
    name: 'telegram_ask',
    description:
      'Ask the user a question with optional inline buttons. Two-phase: sends immediately, the user\'s response arrives in your next message turn. Use for confirmations before self-editing or deploying, and for multi-choice prompts.',
    parameters: TelegramAskParams,
    execute: async (_toolCallId: string, args: TelegramAskInput) => {
      if (args.options && (args.options.length < 2 || args.options.length > 4)) {
        return { output: 'Options must have 2-4 items.' }
      }

      const askId = nanoid(12)
      const conversationId = await getOrCreateConversation(db, 'telegram', telegram.chatId)

      await createPendingAsk(db, {
        id: askId,
        conversationId,
        chatId: telegram.chatId,
        question: args.question,
        options: args.options,
      })

      telegram.sideEffects.askPayload = {
        askId,
        question: args.question,
        options: args.options,
      }
      telegram.sideEffects.suppressText = true

      return {
        output: `Question sent to user. The user's response will appear in your next message. Do NOT answer the question yourself — wait for the user.`,
      }
    },
  }
}
