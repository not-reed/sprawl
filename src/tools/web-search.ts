import { Type, type Static } from '@sinclair/typebox'
import { toolLog } from '../logger.js'

const WebSearchParams = Type.Object({
  query: Type.String({
    description: 'The search query',
  }),
  max_results: Type.Optional(
    Type.Number({
      description: 'Max number of results to return (default: 5)',
    }),
  ),
})

type WebSearchInput = Static<typeof WebSearchParams>

interface TavilyResult {
  title: string
  url: string
  content: string
  score: number
}

interface TavilyResponse {
  results: TavilyResult[]
  answer?: string
}

export function createWebSearchTool(apiKey: string) {
  return {
    name: 'web_search',
    description:
      'Search the web for information. Returns relevant results with snippets. Use this for finding current news, weather, facts, or anything you need to look up.',
    parameters: WebSearchParams,
    execute: async (_toolCallId: string, args: WebSearchInput) => {
      toolLog.info`Searching web for: ${args.query}`

      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: apiKey,
          query: args.query,
          max_results: args.max_results ?? 5,
          include_answer: true,
        }),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Tavily returned ${response.status}: ${body.slice(0, 200)}`)
      }

      const data = (await response.json()) as TavilyResponse

      const lines: string[] = []

      if (data.answer) {
        lines.push(`**Summary:** ${data.answer}`, '')
      }

      for (const r of data.results) {
        lines.push(`### ${r.title}`)
        lines.push(r.url)
        lines.push(r.content)
        lines.push('')
      }

      const output = lines.length > 0
        ? lines.join('\n')
        : 'No results found.'

      return {
        output,
        details: {
          query: args.query,
          resultCount: data.results.length,
          hasAnswer: !!data.answer,
        },
      }
    },
  }
}
