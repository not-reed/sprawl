import { defineCommand, runMain } from 'citty'
import { createInterface } from 'node:readline'
import { createDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { env } from '../src/env.js'
import { processMessage, isDev } from '../src/agent.js'
import { selectAndCreateTools } from '../src/tools/packs.js'

const main = defineCommand({
  meta: {
    name: 'construct',
    description: 'Construct CLI — personal braindump companion',
  },
  args: {
    message: {
      type: 'positional',
      description: 'One-shot message to send to the agent',
      required: false,
    },
    tool: {
      type: 'string',
      description: 'Invoke a specific tool directly (for testing)',
    },
    args: {
      type: 'string',
      alias: 'a',
      description: 'JSON arguments for --tool',
    },
  },
  async run({ args }) {
    // Run migrations
    await runMigrations(env.DATABASE_URL)

    const { db } = createDb(env.DATABASE_URL)

    // Direct tool invocation mode
    if (args.tool) {
      await runTool(db, args.tool, args.args)
      process.exit(0)
    }

    // One-shot mode
    if (args.message) {
      const response = await processMessage(db, args.message, {
        source: 'cli',
        externalId: 'cli',
      })
      console.log(response.text)
      process.exit(0)
    }

    // Interactive REPL mode
    console.log('Construct interactive mode. Type "exit" or Ctrl+C to quit.\n')

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    const prompt = () => {
      rl.question('you> ', async (input) => {
        const trimmed = input.trim()
        if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
          rl.close()
          process.exit(0)
        }

        try {
          const response = await processMessage(db, trimmed, {
            source: 'cli',
            externalId: 'cli',
          })
          console.log(`\nconstruct> ${response.text}\n`)
        } catch (err) {
          console.error('Error:', err)
        }

        prompt()
      })
    }

    prompt()
  },
})

async function runTool(
  db: ReturnType<typeof createDb>['db'],
  toolName: string,
  argsJson?: string,
) {
  // Load all tools (no query embedding → all packs selected)
  const tools = selectAndCreateTools(undefined, {
    db,
    chatId: 'cli',
    apiKey: env.OPENROUTER_API_KEY,
    projectRoot: env.PROJECT_ROOT,
    dbPath: env.DATABASE_URL,
    tavilyApiKey: env.TAVILY_API_KEY,
    logFile: env.LOG_FILE,
    isDev,
  })
  const tool = tools.find((t) => t.name === toolName)

  if (!tool) {
    const available = tools.map((t) => t.name).join(', ')
    console.error(`Unknown tool: ${toolName}`)
    console.error(`Available tools: ${available}`)
    process.exit(1)
  }

  const parsedArgs = argsJson ? JSON.parse(argsJson) : {}

  console.log(`Running tool: ${toolName}`)
  console.log(`Args: ${JSON.stringify(parsedArgs, null, 2)}\n`)

  const result = await tool.execute(`cli-${Date.now()}`, parsedArgs)
  console.log(result.output)
}

runMain(main)
