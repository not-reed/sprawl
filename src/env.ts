import { z } from 'zod'
import { resolve } from 'node:path'

const envSchema = z.object({
  // Required
  OPENROUTER_API_KEY: z.string(),
  TELEGRAM_BOT_TOKEN: z.string(),

  // Optional with defaults
  TAVILY_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-sonnet-4'),
  DATABASE_URL: z.string().default('./data/nullclaw.db'),
  ALLOWED_TELEGRAM_IDS: z
    .string()
    .default('')
    .transform((s) => s.split(',').filter(Boolean)),
  TIMEZONE: z.string().default('UTC'),
  LOG_LEVEL: z.string().default('info'),
  PROJECT_ROOT: z
    .string()
    .default('.')
    .transform((p) => resolve(p)),
})

export const env = envSchema.parse(process.env)
