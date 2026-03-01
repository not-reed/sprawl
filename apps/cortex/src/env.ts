import { z } from 'zod'

const envSchema = z.object({
  // Required
  OPENROUTER_API_KEY: z.string(),

  // Optional
  CRYPTOPANIC_API_KEY: z.string().optional(),
  CRYPTOCOMPARE_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().default('./data/cortex.db'),
  TRACKED_TOKENS: z
    .string()
    .default('bitcoin,ethereum')
    .transform((s) => s.split(',').filter(Boolean)),
  EMBEDDING_MODEL: z.string().default('qwen/qwen3-embedding-4b'),
  MEMORY_WORKER_MODEL: z.string().default('google/gemini-3-flash-preview'),
  ANALYZER_MODEL: z.string().optional(),

  // Intervals (seconds)
  PRICE_INTERVAL: z
    .string()
    .default('300')
    .transform((s) => parseInt(s, 10)),
  NEWS_INTERVAL: z
    .string()
    .default('900')
    .transform((s) => parseInt(s, 10)),
  SIGNAL_INTERVAL: z
    .string()
    .default('3600')
    .transform((s) => parseInt(s, 10)),
})

export const env = envSchema.parse(process.env)
