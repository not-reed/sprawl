import { Type, type Static } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { getUsageStats } from '../../db/queries.js'

const UsageStatsParams = Type.Object({
  days: Type.Optional(
    Type.Number({
      description: 'Number of days to look back (default 30, max 365)',
      minimum: 1,
      maximum: 365,
    }),
  ),
  source: Type.Optional(
    Type.String({
      description: "Filter by source: 'telegram' or 'cli'",
    }),
  ),
})

type UsageStatsInput = Static<typeof UsageStatsParams>

export function createUsageStatsTool(db: Kysely<Database>) {
  return {
    name: 'usage_stats',
    description:
      'Get AI usage statistics — total cost, token counts, and message volume over a time period. Use when the user asks about spending, costs, or usage.',
    parameters: UsageStatsParams,
    execute: async (_toolCallId: string, args: UsageStatsInput) => {
      const stats = await getUsageStats(db, {
        days: args.days,
        source: args.source,
      })

      const period = args.days ?? 30
      const sourceLabel = args.source ? ` (${args.source} only)` : ''

      const lines: string[] = [
        `Usage stats — last ${period} day(s)${sourceLabel}:`,
        `  Total cost: $${stats.total_cost.toFixed(4)}`,
        `  Input tokens: ${stats.total_input_tokens.toLocaleString()}`,
        `  Output tokens: ${stats.total_output_tokens.toLocaleString()}`,
        `  Messages: ${stats.message_count}`,
      ]

      if (stats.daily.length > 0) {
        lines.push('', 'Per-day breakdown:')
        for (const d of stats.daily) {
          lines.push(`  ${d.date}  $${d.cost.toFixed(4)}  ${d.messages} msgs`)
        }
      }

      return {
        output: lines.join('\n'),
        details: stats,
      }
    },
  }
}
