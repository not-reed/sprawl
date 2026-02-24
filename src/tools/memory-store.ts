import { Type, type Static } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import { storeMemory, updateMemoryEmbedding } from '../db/queries.js'
import type { Database } from '../db/schema.js'
import { generateEmbedding } from '../embeddings.js'
import { toolLog } from '../logger.js'

const MemoryStoreParams = Type.Object({
  content: Type.String({
    description: 'The memory to store (fact, note, preference, reminder, etc.)',
  }),
  category: Type.Optional(
    Type.String({
      description:
        'Category: general, preference, fact, reminder, note. Defaults to general.',
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Tags for keyword search (e.g. ["dentist", "appointment", "march"])',
    }),
  ),
})

type MemoryStoreInput = Static<typeof MemoryStoreParams>

export function createMemoryStoreTool(db: Kysely<Database>, apiKey?: string) {
  return {
    name: 'memory_store',
    description:
      'Store a memory for long-term recall. Use this proactively when the user shares facts, preferences, notes, or anything worth remembering.',
    parameters: MemoryStoreParams,
    execute: async (_toolCallId: string, args: MemoryStoreInput) => {
      const memory = await storeMemory(db, {
        content: args.content,
        category: args.category ?? 'general',
        tags: args.tags ? JSON.stringify(args.tags) : null,
        source: 'user',
      })

      // Generate embedding in the background — don't block the response
      if (apiKey) {
        generateEmbedding(apiKey, args.content)
          .then((embedding) => updateMemoryEmbedding(db, memory.id, embedding))
          .then(() => toolLog.info`Embedding generated for memory [${memory.id}]`)
          .catch((err) => toolLog.error`Failed to generate embedding for [${memory.id}]: ${err}`)
      }

      return {
        output: `Stored memory [${memory.id}]: "${memory.content}" (${memory.category})`,
        details: { memory },
      }
    },
  }
}
