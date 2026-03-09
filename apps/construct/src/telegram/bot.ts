import { Bot, InlineKeyboard } from 'grammy'
import type { Kysely } from 'kysely'
import { env } from '../env.js'
import { telegramLog } from '../logger.js'
import { processMessage } from '../agent.js'
import type { Database } from '../db/schema.js'
import {
  getOrCreateConversation,
  getMessageByTelegramId,
  updateTelegramMessageId,
  getPendingAsk,
  getPendingAskById,
  resolvePendingAsk,
  setPendingAskTelegramId,
} from '../db/queries.js'
import type { AskPayload, TelegramSideEffects, TelegramContext } from './types.js'
import { markdownToTelegramHtml } from './format.js'

export function createBot(db: Kysely<Database>) {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN)
  const allowedIds = env.ALLOWED_TELEGRAM_IDS

  // Per-chat message queue to prevent concurrent processMessage() calls
  // on the same conversation (causes race conditions / agent hangs)
  const chatQueues = new Map<string, { pending: Promise<void>; depth: number }>()

  function enqueue(chatId: string, fn: () => Promise<void>): Promise<void> {
    const entry = chatQueues.get(chatId)
    const prev = entry?.pending ?? Promise.resolve()
    const depth = (entry?.depth ?? 0) + 1
    const next = prev.then(fn, fn)
    chatQueues.set(chatId, { pending: next, depth })
    next.then(() => {
      const cur = chatQueues.get(chatId)
      if (cur) {
        cur.depth--
        if (cur.depth <= 0) {
          chatQueues.delete(chatId)
          replyToActive.delete(chatId)
        }
      }
    })
    return next
  }

  // Tracks chats where reply-to threading is active.
  // Activates when a queue forms (depth > 1), stays on until queue fully drains.
  const replyToActive = new Set<string>()

  function shouldReplyTo(chatId: string): boolean {
    const depth = chatQueues.get(chatId)?.depth ?? 0
    if (depth > 1) replyToActive.add(chatId)
    return replyToActive.has(chatId)
  }

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
      const base = isFirst ? replyParams : {}
      try {
        return await ctx.reply(markdownToTelegramHtml(chunk), { ...base, parse_mode: 'HTML' as const })
      } catch {
        // HTML parse failed — send as plain text
        return await ctx.reply(chunk, base)
      }
    }

    let sentMessage: any
    if (text.length <= maxLen) {
      sentMessage = await send(text, true)
    } else {
      for (let i = 0; i < text.length; i += maxLen) {
        const msg = await send(text.slice(i, i + maxLen), i === 0)
        if (i === 0) sentMessage = msg
      }
    }

    // Write back the Telegram message ID of the first sent message
    if (sentMessage?.message_id && assistantMessageId) {
      await updateTelegramMessageId(db, assistantMessageId, sentMessage.message_id).catch(
        (err) => telegramLog.error`Failed to track sent message ID: ${err}`,
      )
    }
  }

  /**
   * Send an ask message with optional inline keyboard buttons.
   * Returns the sent message so we can track its telegram_message_id.
   */
  async function sendAskMessage(chatId: string, payload: AskPayload) {
    const keyboard = new InlineKeyboard()
    if (payload.options) {
      for (let i = 0; i < payload.options.length; i++) {
        keyboard.text(payload.options[i], `ask:${payload.askId}:${i}`)
        if (i < payload.options.length - 1) keyboard.row()
      }
    }

    const sendOpts = payload.options
      ? { reply_markup: keyboard }
      : {}

    try {
      const sent = await bot.api.sendMessage(
        chatId,
        markdownToTelegramHtml(payload.question),
        { ...sendOpts, parse_mode: 'HTML' as const },
      )
      return sent
    } catch {
      // HTML parse failed — send as plain text
      const sent = await bot.api.sendMessage(chatId, payload.question, sendOpts)
      return sent
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

    enqueue(chatId, async () => {
      // Show typing indicator, refreshing every 4s (Telegram expires it after ~5s)
      const sendTyping = () =>
        ctx.replyWithChatAction('typing').catch((err) => {
          telegramLog.error`Typing indicator failed: ${err}`
        })
      const typingInterval = setInterval(sendTyping, 4000)
      await sendTyping()

      try {
        // Check for pending ask — resolve it and prepend soft context
        let messageText = ctx.message.text
        const pendingAsk = await getPendingAsk(db, chatId)
        if (pendingAsk) {
          await resolvePendingAsk(db, pendingAsk.id, messageText)
          messageText = `[You had asked: "${pendingAsk.question}". User's next message:]\n${messageText}`

          // Edit original ask message to show answered state + remove keyboard
          if (pendingAsk.telegram_message_id) {
            try {
              await bot.api.editMessageText(
                chatId,
                pendingAsk.telegram_message_id,
                `${pendingAsk.question}\n\n<i>Answered</i>`,
                { parse_mode: 'HTML', reply_markup: undefined },
              )
            } catch (err) {
              telegramLog.error`Failed to edit ask message: ${err}`
            }
          }
        }

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

        const response = await processMessage(db, messageText, {
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

        // Process side effects: ask payload
        if (sideEffects.askPayload) {
          try {
            const sent = await sendAskMessage(chatId, sideEffects.askPayload)
            await setPendingAskTelegramId(db, sideEffects.askPayload.askId, sent.message_id)
          } catch (err) {
            telegramLog.error`Failed to send ask message: ${err}`
          }
        }

        // Auto-reply-to the incoming message when multiple messages are queued,
        // so responses thread correctly instead of appearing as disconnected messages
        if (!sideEffects.replyToMessageId && shouldReplyTo(chatId)) {
          sideEffects.replyToMessageId = ctx.message.message_id
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
  })

  bot.on('callback_query:data', async (ctx) => {
    const userId = String(ctx.from.id)
    if (!isAuthorized(userId)) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized.' })
      return
    }

    const data = ctx.callbackQuery.data
    const match = data.match(/^ask:([^:]+):(\d+)$/)
    if (!match) {
      await ctx.answerCallbackQuery()
      return
    }

    const [, askId, indexStr] = match
    const optionIndex = parseInt(indexStr, 10)
    const chatId = String(ctx.chat!.id)

    const ask = await getPendingAskById(db, askId)
    if (!ask || ask.resolved_at) {
      await ctx.answerCallbackQuery({ text: 'This question has expired.' })
      return
    }

    // Check 10-min expiry
    const createdAt = new Date(ask.created_at + 'Z').getTime()
    if (Date.now() - createdAt > 10 * 60 * 1000) {
      await ctx.answerCallbackQuery({ text: 'This question has expired.' })
      return
    }

    const options: string[] = ask.options ? JSON.parse(ask.options) : []
    const selectedOption = options[optionIndex]
    if (!selectedOption) {
      await ctx.answerCallbackQuery({ text: 'Invalid option.' })
      return
    }

    // Resolve ask in DB
    await resolvePendingAsk(db, askId, selectedOption)
    await ctx.answerCallbackQuery({ text: `Selected: ${selectedOption}` })

    // Edit original message to show selection + remove keyboard
    try {
      await ctx.editMessageText(
        `${ask.question}\n\n<b>${selectedOption}</b>`,
        { parse_mode: 'HTML', reply_markup: undefined },
      )
    } catch (err) {
      telegramLog.error`Failed to edit ask message after callback: ${err}`
    }

    // Enqueue synthetic message through processMessage
    enqueue(chatId, async () => {
      const sendTyping = () =>
        bot.api.sendChatAction(chatId, 'typing').catch((err) => {
          telegramLog.error`Typing indicator failed: ${err}`
        })
      const typingInterval = setInterval(sendTyping, 4000)
      await sendTyping()

      try {
        const syntheticMessage = `[User answered your question "${ask.question}": ${selectedOption}]`

        const sideEffects: TelegramSideEffects = {}
        const telegramCtx: TelegramContext = {
          bot,
          chatId,
          incomingMessageId: ctx.callbackQuery.message?.message_id ?? 0,
          sideEffects,
        }

        const response = await processMessage(db, syntheticMessage, {
          source: 'telegram',
          externalId: chatId,
          chatId,
          telegram: telegramCtx,
        })

        // Process side effects: reaction (on the ask message itself)
        if (sideEffects.reactToUser && ctx.callbackQuery.message?.message_id) {
          try {
            await bot.api.setMessageReaction(chatId, ctx.callbackQuery.message.message_id, [
              { type: 'emoji', emoji: sideEffects.reactToUser as any },
            ])
          } catch (err) {
            telegramLog.error`Failed to react: ${err}`
          }
        }

        // Process side effects: ask payload (agent can chain asks)
        if (sideEffects.askPayload) {
          try {
            const sent = await sendAskMessage(chatId, sideEffects.askPayload)
            await setPendingAskTelegramId(db, sideEffects.askPayload.askId, sent.message_id)
          } catch (err) {
            telegramLog.error`Failed to send ask message: ${err}`
          }
        }

        if (!sideEffects.suppressText && response.text.trim()) {
          await sendReply(
            { reply: (text: string, extra?: any) => bot.api.sendMessage(chatId, text, extra) },
            response.text,
            sideEffects,
            response.messageId,
          )
        }
      } catch (err) {
        telegramLog.error`Error processing callback query: ${err}`
      } finally {
        clearInterval(typingInterval)
      }
    })
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
    const emojiStr = newEmojis.join('')

    telegramLog.info`Reaction from user ${userId}: ${emojiStr} on message ${telegramMsgId}`

    enqueue(chatId, async () => {
      // Look up the reacted-to message
      const conversationId = await getOrCreateConversation(db, 'telegram', chatId)
      const message = await getMessageByTelegramId(db, conversationId, telegramMsgId)
      const whose = message?.role === 'assistant' ? 'your' : 'their'
      const preview = message?.content?.slice(0, 100) ?? '(unknown message)'

      const syntheticMessage = `[User reacted with ${emojiStr} to ${whose} message: "${preview}"]`

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
  })

  bot.on('message', async (ctx) => {
    if (!isAuthorized(String(ctx.from?.id))) return
    // Ignore service messages (pin, unpin, group changes, etc.)
    const m = ctx.message
    if (m.pinned_message || m.new_chat_members || m.left_chat_member || m.new_chat_title || m.new_chat_photo || m.delete_chat_photo || m.group_chat_created || m.supergroup_chat_created || m.migrate_to_chat_id || m.migrate_from_chat_id) return
    await ctx.reply("I can only process text messages for now.")
  })

  bot.catch((err) => {
    telegramLog.error`Grammy error: ${err}`
  })

  return bot
}
