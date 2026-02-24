import { Bot } from 'grammy'
import type { Kysely } from 'kysely'
import { env } from '../env.js'
import { telegramLog } from '../logger.js'
import { processMessage } from '../agent.js'
import type { Database } from '../db/schema.js'
import {
  getOrCreateConversation,
  getMessageByTelegramId,
  updateTelegramMessageId,
} from '../db/queries.js'
import type { TelegramSideEffects, TelegramContext } from './types.js'

export function createBot(db: Kysely<Database>) {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN)
  const allowedIds = env.ALLOWED_TELEGRAM_IDS

  function isAuthorized(userId: string): boolean {
    return allowedIds.length === 0 || allowedIds.includes(userId)
  }

  /**
   * Send the agent's text reply, handling chunking, markdown fallback,
   * reply-to, and message ID tracking.
   */
  async function sendReply(
    ctx: { reply: (...args: any[]) => Promise<any> },
    text: string,
    sideEffects: TelegramSideEffects,
    assistantMessageId?: string,
  ) {
    const maxLen = 4000
    const replyParams = sideEffects.replyToMessageId
      ? { reply_parameters: { message_id: sideEffects.replyToMessageId } }
      : {}

    const send = async (chunk: string, isFirst: boolean) => {
      const extra = {
        parse_mode: 'Markdown' as const,
        ...(isFirst ? replyParams : {}),
      }
      try {
        return await ctx.reply(chunk, extra)
      } catch {
        // Markdown parse failed — send as plain text
        const { parse_mode: _, ...rest } = extra
        return await ctx.reply(chunk, rest)
      }
    }

    let sentMessage: any
    if (text.length <= maxLen) {
      sentMessage = await send(text, true)
    } else {
      for (let i = 0; i < text.length; i += maxLen) {
        sentMessage = await send(text.slice(i, i + maxLen), i === 0)
      }
    }

    // Write back the Telegram message ID of the first sent message
    if (sentMessage?.message_id && assistantMessageId) {
      await updateTelegramMessageId(db, assistantMessageId, sentMessage.message_id).catch(
        (err) => telegramLog.error`Failed to track sent message ID: ${err}`,
      )
    }
  }

  bot.on('message:text', async (ctx) => {
    const userId = String(ctx.from.id)
    const chatId = String(ctx.chat.id)

    if (!isAuthorized(userId)) {
      telegramLog.warning`Unauthorized message from user ${userId}`
      await ctx.reply('Unauthorized.')
      return
    }

    telegramLog.info`Message from user ${userId} (chat ${chatId}): ${ctx.message.text.slice(0, 100)}`

    // Show typing indicator, refreshing every 4s (Telegram expires it after ~5s)
    const typingInterval = setInterval(
      () => void ctx.replyWithChatAction('typing'),
      4000,
    )
    await ctx.replyWithChatAction('typing')

    try {
      // Build telegram context with mutable side-effects
      const sideEffects: TelegramSideEffects = {}
      const telegramCtx: TelegramContext = {
        bot,
        chatId,
        incomingMessageId: ctx.message.message_id,
        sideEffects,
      }

      // Extract reply context if user is replying to a message
      const replyContext = ctx.message.reply_to_message?.text ?? undefined

      const response = await processMessage(db, ctx.message.text, {
        source: 'telegram',
        externalId: chatId,
        chatId,
        telegram: telegramCtx,
        replyContext,
        incomingTelegramMessageId: ctx.message.message_id,
      })

      // Process side effects: reaction
      if (sideEffects.reactToUser) {
        try {
          await bot.api.setMessageReaction(chatId, ctx.message.message_id, [
            { type: 'emoji', emoji: sideEffects.reactToUser as any },
          ])
        } catch (err) {
          telegramLog.error`Failed to react: ${err}`
        }
      }

      // Send text reply (unless suppressed)
      if (!sideEffects.suppressText && response.text) {
        await sendReply(ctx, response.text, sideEffects, response.messageId)
      }

      telegramLog.info`Reply sent to chat ${chatId} (${response.text.length} chars, suppress=${!!sideEffects.suppressText})`
    } catch (err) {
      telegramLog.error`Error processing message: ${err}`
      await ctx.reply('Something went wrong. Check the logs.')
    } finally {
      clearInterval(typingInterval)
    }
  })

  bot.on('message_reaction', async (ctx) => {
    const userId = String(ctx.from!.id)
    const chatId = String(ctx.chat.id)

    if (!isAuthorized(userId)) return

    const update = ctx.messageReaction
    const newEmojis = update.new_reaction
      .filter((r) => r.type === 'emoji')
      .map((r) => (r as { type: 'emoji'; emoji: string }).emoji)

    if (newEmojis.length === 0) return

    const telegramMsgId = update.message_id

    // Look up the reacted-to message
    const conversationId = await getOrCreateConversation(db, 'telegram', chatId)
    const message = await getMessageByTelegramId(db, conversationId, telegramMsgId)

    const emojiStr = newEmojis.join('')
    const whose = message?.role === 'assistant' ? 'your' : 'their'
    const preview = message?.content?.slice(0, 100) ?? '(unknown message)'

    const syntheticMessage = `[User reacted with ${emojiStr} to ${whose} message: "${preview}"]`

    telegramLog.info`Reaction from user ${userId}: ${emojiStr} on message ${telegramMsgId}`

    try {
      const sideEffects: TelegramSideEffects = {}
      const telegramCtx: TelegramContext = {
        bot,
        chatId,
        incomingMessageId: telegramMsgId,
        sideEffects,
      }

      const response = await processMessage(db, syntheticMessage, {
        source: 'telegram',
        externalId: chatId,
        chatId,
        telegram: telegramCtx,
      })

      // Process reaction side-effect on the reacted message
      if (sideEffects.reactToUser) {
        try {
          await bot.api.setMessageReaction(chatId, telegramMsgId, [
            { type: 'emoji', emoji: sideEffects.reactToUser as any },
          ])
        } catch (err) {
          telegramLog.error`Failed to react: ${err}`
        }
      }

      // Only send text if agent produced a non-empty response and not suppressed
      if (!sideEffects.suppressText && response.text.trim()) {
        await sendReply(
          { reply: (text: string, extra?: any) => bot.api.sendMessage(chatId, text, extra) },
          response.text,
          sideEffects,
          response.messageId,
        )
      }
    } catch (err) {
      telegramLog.error`Error processing reaction: ${err}`
    }
  })

  bot.on('message', async (ctx) => {
    await ctx.reply("I can only process text messages for now.")
  })

  bot.catch((err) => {
    telegramLog.error`Grammy error: ${err}`
  })

  return bot
}
