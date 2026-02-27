import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().default('./data/construct.db'),
  OPENROUTER_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('qwen/qwen3-embedding-4b'),
  PORT: z.coerce.number().default(4800),
})

export const env = envSchema.parse(process.env)
