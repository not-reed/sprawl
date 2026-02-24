import { Type, type Static } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import { recallMemories } from '../db/queries.js'
import type { Database } from '../db/schema.js'
import { generateEmbedding } from '../embeddings.js'
import { toolLog } from '../logger.js'

const MemoryRecallParams = Type.Object({
  query: Type.String({
    description: 'Search query — keywords or topic to search for in memories',
  }),
  category: Type.Optional(
    Type.String({
      description: 'Filter by category: general, preference, fact, reminder, note',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Max number of results to return (default: 10)',
    }),
  ),
})

type MemoryRecallInput = Static<typeof MemoryRecallParams>

export function createMemoryRecallTool(db: Kysely<Database>, apiKey?: string) {
  return {
    name: 'memory_recall',
    description:
      'Search long-term memories by keyword or topic. Uses full-text search and semantic similarity. Use this when the user asks about something you might have stored, or when you need context from past conversations.',
    parameters: MemoryRecallParams,
    execute: async (_toolCallId: string, args: MemoryRecallInput) => {
      // Generate query embedding for semantic search
      let queryEmbedding: number[] | undefined
      if (apiKey) {
        try {
          queryEmbedding = await generateEmbedding(apiKey, args.query)
        } catch (err) {
          toolLog.warning`Failed to generate query embedding, falling back to text search: ${err}`
        }
      }

      const memories = await recallMemories(db, args.query, {
        category: args.category,
        limit: args.limit,
        queryEmbedding,
      })

      if (memories.length === 0) {
        return {
          output: `No memories found matching "${args.query}".`,
          details: { memories: [] },
        }
      }

      const lines = memories.map((m) => {
        const match = m.matchType ? ` [${m.matchType}]` : ''
        const score = m.score !== undefined ? ` (${(m.score * 100).toFixed(0)}%)` : ''
        return `[${m.id}] (${m.category}) ${m.content}${m.tags ? ` — tags: ${m.tags}` : ''}${match}${score}`
      })

      return {
        output: `Found ${memories.length} memories:\n${lines.join('\n')}`,
        details: { memories },
      }
    },
  }
}
