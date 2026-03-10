import { z } from 'zod'
import { intFromEnv, csvFromEnv } from '@repo/env'

const envSchema = z.object({
  // Required
  OPENROUTER_API_KEY: z.string(),

  // Optional
  CRYPTOPANIC_API_KEY: z.string().optional(),
  CRYPTOCOMPARE_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().default('./data/cortex.db'),
  TRACKED_TOKENS: csvFromEnv('bitcoin,ethereum'),
  EMBEDDING_MODEL: z.string().default('qwen/qwen3-embedding-4b'),
  MEMORY_WORKER_MODEL: z.string().default('google/gemini-3-flash-preview'),
  ANALYZER_MODEL: z.string().optional(),

  // Intervals (seconds)
  PRICE_INTERVAL: intFromEnv('300'),
  NEWS_INTERVAL: intFromEnv('900'),
  SIGNAL_INTERVAL: intFromEnv('3600'),
})

export const env = envSchema.parse(process.env)
