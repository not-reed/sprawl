import { Type, type Static } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import { forgetMemory, searchMemoriesForForget } from '../../db/queries.js'
import type { Database } from '../../db/schema.js'

const MemoryForgetParams = Type.Object({
  id: Type.Optional(
    Type.String({ description: 'Specific memory ID to archive' }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        'Search query to find memories to archive. Returns candidates — use the id param to confirm.',
    }),
  ),
})

type MemoryForgetInput = Static<typeof MemoryForgetParams>

export function createMemoryForgetTool(db: Kysely<Database>) {
  return {
    name: 'memory_forget',
    description:
      'Archive (soft-delete) a memory. Either provide a specific memory ID, or search by query to find candidates first.',
    parameters: MemoryForgetParams,
    execute: async (_toolCallId: string, args: MemoryForgetInput) => {
      if (args.id) {
        const success = await forgetMemory(db, args.id)
        if (success) {
          return {
            output: `Archived memory [${args.id}].`,
            details: { archived: args.id },
          }
        }
        return {
          output: `Memory [${args.id}] not found or already archived.`,
          details: { archived: null },
        }
      }

      if (args.query) {
        const candidates = await searchMemoriesForForget(db, args.query)
        if (candidates.length === 0) {
          return {
            output: `No memories found matching "${args.query}".`,
            details: { candidates: [] },
          }
        }

        const lines = candidates.map(
          (m) => `[${m.id}] (${m.category}) ${m.content}`,
        )
        return {
          output: `Found ${candidates.length} memories matching "${args.query}". Call memory_forget with a specific id to archive one:\n${lines.join('\n')}`,
          details: { candidates },
        }
      }

      return {
        output: 'Please provide either an id or a query to find memories to archive.',
        details: {},
      }
    },
  }
}
