import { Type, type Static } from '@sinclair/typebox'
import { toolLog } from '../logger.js'

const WebReadParams = Type.Object({
  url: Type.String({
    description: 'The URL to read and extract content from',
  }),
})

type WebReadInput = Static<typeof WebReadParams>

export function createWebReadTool() {
  return {
    name: 'web_read',
    description:
      'Read a web page and return its content as clean markdown. Use this to check news, weather, documentation, articles, or any public web page.',
    parameters: WebReadParams,
    execute: async (_toolCallId: string, args: WebReadInput) => {
      const jinaUrl = `https://r.jina.ai/${args.url}`
      toolLog.info`Fetching ${args.url} via Jina Reader`

      const response = await fetch(jinaUrl, {
        headers: {
          Accept: 'text/markdown',
        },
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Jina Reader returned ${response.status}: ${body.slice(0, 200)}`)
      }

      const markdown = await response.text()

      // Truncate if extremely long to avoid blowing up context
      const maxLen = 12_000
      const truncated = markdown.length > maxLen
      const content = truncated
        ? markdown.slice(0, maxLen) + '\n\n[... truncated]'
        : markdown

      return {
        output: content,
        details: {
          url: args.url,
          length: markdown.length,
          truncated,
        },
      }
    },
  }
}
