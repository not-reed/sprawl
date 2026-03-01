import { Type, type Static } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import { recallMemories, generateEmbedding, searchNodes, traverseGraph, getRelatedMemoryIds, type Memory } from '@repo/cairn'
import type { Database } from '../../db/schema.js'
import { toolLog } from '../../logger.js'

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

export function createMemoryRecallTool(db: Kysely<Database>, apiKey?: string, embeddingModel?: string) {
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
          queryEmbedding = await generateEmbedding(apiKey, args.query, embeddingModel)
        } catch (err) {
          toolLog.warning`Failed to generate query embedding, falling back to text search: ${err}`
        }
      }

      const memories = await recallMemories(db, args.query, {
        category: args.category,
        limit: args.limit,
        queryEmbedding,
      })

      // Expand via graph traversal — find related memories not in direct results
      let graphMemories: (Memory & { matchType: string })[] = []
      try {
        const seen = new Set(memories.map((m) => m.id))
        const graphNodes = await searchNodes(db, args.query, 5, queryEmbedding)

        if (graphNodes.length > 0) {
          // Traverse 1-2 hops from matching nodes
          const allNodeIds = new Set<string>()
          for (const node of graphNodes) {
            allNodeIds.add(node.id)
            const traversed = await traverseGraph(db, node.id, 2)
            for (const t of traversed) {
              allNodeIds.add(t.node.id)
            }
          }

          // Find memories linked to these nodes
          const relatedMemIds = await getRelatedMemoryIds(db, [...allNodeIds])
          const newMemIds = relatedMemIds.filter((id) => !seen.has(id))

          if (newMemIds.length > 0) {
            const relatedMems = await db
              .selectFrom('memories')
              .selectAll()
              .where('id', 'in', newMemIds)
              .where('archived_at', 'is', null)
              .limit(5)
              .execute()

            graphMemories = relatedMems.map((m) => ({ ...m, matchType: 'graph' }))
          }
        }
      } catch (err) {
        toolLog.warning`Graph expansion failed: ${err}`
      }

      const allResults = [...memories, ...graphMemories]

      if (allResults.length === 0) {
        return {
          output: `No memories found matching "${args.query}".`,
          details: { memories: [] },
        }
      }

      const lines = allResults.map((m) => {
        const match = m.matchType ? ` [${m.matchType}]` : ''
        const score = 'score' in m && m.score !== undefined ? ` (${(m.score * 100).toFixed(0)}%)` : ''
        return `[${m.id}] (${m.category}) ${m.content}${m.tags ? ` — tags: ${m.tags}` : ''}${match}${score}`
      })

      return {
        output: `Found ${allResults.length} memories:\n${lines.join('\n')}`,
        details: { memories: allResults },
      }
    },
  }
}
