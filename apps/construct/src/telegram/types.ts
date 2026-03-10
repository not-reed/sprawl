import type { Bot } from "grammy";

export interface AskPayload {
  askId: string;
  question: string;
  options?: string[];
}

export interface TelegramSideEffects {
  reactToUser?: string;
  replyToMessageId?: number;
  suppressText?: boolean;
  askPayload?: AskPayload;
}

export interface TelegramContext {
  bot: Bot;
  chatId: string;
  incomingMessageId: number;
  sideEffects: TelegramSideEffects;
}
