import type { Bot } from 'grammy'

export interface TelegramSideEffects {
  reactToUser?: string
  replyToMessageId?: number
  suppressText?: boolean
}

export interface TelegramContext {
  bot: Bot
  chatId: string
  incomingMessageId: number
  sideEffects: TelegramSideEffects
}
