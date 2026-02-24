import { Bot } from 'grammy'
import type { Kysely } from 'kysely'
import { env } from '../env.js'
import { telegramLog } from '../logger.js'
import { processMessage } from '../agent.js'
import type { Database } from '../db/schema.js'

export function createBot(db: Kysely<Database>) {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN)
  const allowedIds = env.ALLOWED_TELEGRAM_IDS

  bot.on('message:text', async (ctx) => {
    const userId = String(ctx.from.id)
    const chatId = String(ctx.chat.id)

    // Auth check
    if (allowedIds.length > 0 && !allowedIds.includes(userId)) {
      telegramLog.warning`Unauthorized message from user ${userId}`
      await ctx.reply('Unauthorized.')
      return
    }

    telegramLog.info`Message from user ${userId} (chat ${chatId}): ${ctx.message.text.slice(0, 100)}`

    // Show typing indicator
    await ctx.replyWithChatAction('typing')

    try {
      const response = await processMessage(db, ctx.message.text, {
        source: 'telegram',
        externalId: chatId,
        chatId,
      })

      if (response.text) {
        // Telegram has a 4096 char limit per message
        const maxLen = 4000
        const send = async (text: string) => {
          try {
            await ctx.reply(text, { parse_mode: 'Markdown' })
          } catch {
            // Markdown parse failed (unbalanced markers, etc) — send as plain text
            await ctx.reply(text)
          }
        }

        if (response.text.length <= maxLen) {
          await send(response.text)
        } else {
          for (let i = 0; i < response.text.length; i += maxLen) {
            await send(response.text.slice(i, i + maxLen))
          }
        }
      }

      telegramLog.info`Reply sent to chat ${chatId} (${response.text.length} chars)`
    } catch (err) {
      telegramLog.error`Error processing message: ${err}`
      await ctx.reply('Something went wrong. Check the logs.')
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
