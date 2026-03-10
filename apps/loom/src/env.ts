import { z } from "zod";

const envSchema = z.object({
  OPENROUTER_API_KEY: z.string(),
  OPENROUTER_MODEL: z.string().default("google/gemini-3-flash-preview"),
  DATABASE_URL: z.string().default("./data/loom.db"),
  PORT: z.coerce.number().default(4900),
  EMBEDDING_MODEL: z.string().default("qwen/qwen3-embedding-4b"),
  MEMORY_WORKER_MODEL: z.string().optional(),
  TIMEZONE: z.string().default("UTC"),
  RULES_DIR: z.string().default("./rules"),
  NODE_ENV: z.string().default("production"),
  TTS_ENABLED: z.coerce.boolean().default(false),
  TTS_SCRIPTIFY: z.coerce.boolean().default(true),
  KOKORO_URL: z.string().default("http://localhost:8880"),
  KOKORO_VOICE: z.string().default("af_heart"),
});

export const env = envSchema.parse(process.env);
