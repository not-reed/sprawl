import { Type, type Static } from "@sinclair/typebox";
import { toolLog } from "../../logger.js";
import { ToolError } from "../../errors.js";

const WebParams = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("read")], {
    description:
      'Action: "search" to search the web, "read" to fetch and extract a page\'s content',
  }),
  query: Type.Optional(Type.String({ description: 'Search query (required for "search" action)' })),
  url: Type.Optional(Type.String({ description: 'URL to read (required for "read" action)' })),
  max_results: Type.Optional(
    Type.Number({ description: "Max search results to return (default: 5)" }),
  ),
});

type WebInput = Static<typeof WebParams>;

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

export function createWebTool(apiKey: string) {
  return {
    name: "web" as const,
    description:
      'Web access. "search" finds current information (news, weather, facts). "read" fetches and extracts a web page as clean markdown.',
    parameters: WebParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as WebInput;

      switch (typed.action) {
        case "search": {
          if (!typed.query) {
            return {
              output: 'The "search" action requires a "query" parameter.',
              details: { error: "missing_params" },
            };
          }

          toolLog.info`Searching web for: ${typed.query}`;

          const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: apiKey,
              query: typed.query,
              max_results: typed.max_results ?? 5,
              include_answer: true,
            }),
          });

          if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new ToolError(`Tavily returned ${response.status}: ${body.slice(0, 200)}`);
          }

          const data = (await response.json()) as TavilyResponse;

          const lines: string[] = [];
          if (data.answer) {
            lines.push(`**Summary:** ${data.answer}`, "");
          }
          for (const r of data.results) {
            lines.push(`### ${r.title}`);
            lines.push(r.url);
            lines.push(r.content);
            lines.push("");
          }

          const output = lines.length > 0 ? lines.join("\n") : "No results found.";
          return {
            output,
            details: {
              query: typed.query,
              resultCount: data.results.length,
              hasAnswer: !!data.answer,
            },
          };
        }

        case "read": {
          if (!typed.url) {
            return {
              output: 'The "read" action requires a "url" parameter.',
              details: { error: "missing_params" },
            };
          }

          const jinaUrl = `https://r.jina.ai/${typed.url}`;
          toolLog.info`Fetching ${typed.url} via Jina Reader`;

          const response = await fetch(jinaUrl, {
            headers: { Accept: "text/markdown" },
          });

          if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new ToolError(`Jina Reader returned ${response.status}: ${body.slice(0, 200)}`);
          }

          const markdown = await response.text();
          const maxLen = 12_000;
          const truncated = markdown.length > maxLen;
          const content = truncated ? markdown.slice(0, maxLen) + "\n\n[... truncated]" : markdown;

          return {
            output: content,
            details: { url: typed.url, length: markdown.length, truncated },
          };
        }

        default:
          return {
            output: `Unknown action: ${typed.action}`,
            details: { error: "unknown_action" },
          };
      }
    },
  };
}
