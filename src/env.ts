import { z } from 'zod'
import { resolve, join } from 'node:path'

function defaultExtensionsDir(): string {
  if (process.env.NODE_ENV === 'development') return './data'
  const xdg = process.env.XDG_DATA_HOME || join(process.env.HOME || '~', '.local', 'share')
  return join(xdg, 'construct')
}

const envSchema = z.object({
  // Required
  OPENROUTER_API_KEY: z.string(),
  TELEGRAM_BOT_TOKEN: z.string(),

  // Optional
  NODE_ENV: z.string().default('production'),
  TAVILY_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-sonnet-4'),
  DATABASE_URL: z.string().default('./data/construct.db'),
  ALLOWED_TELEGRAM_IDS: z
    .string()
    .default('')
    .transform((s) => s.split(',').filter(Boolean)),
  TIMEZONE: z.string().default('UTC'),
  LOG_LEVEL: z.string().default('info'),
  LOG_FILE: z.string().default('./data/construct.log'),
  PROJECT_ROOT: z
    .string()
    .default('.')
    .transform((p) => resolve(p)),
  EXTENSIONS_DIR: z
    .string()
    .default(defaultExtensionsDir())
    .transform((p) => resolve(p)),
})

export const env = envSchema.parse(process.env)
