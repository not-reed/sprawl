# CLI Interface

*Last updated: 2026-02-24 -- Initial documentation*

## Overview

The CLI provides a local interface to Construct without requiring Telegram. Built with Citty (a lightweight CLI framework), it supports three modes: interactive REPL, one-shot messages, and direct tool invocation. It shares the same `processMessage()` pipeline as Telegram.

## Key Files

| File | Role |
|------|------|
| `cli/index.ts` | CLI entry point: command definition, REPL, one-shot, and tool modes |

## Modes of Operation

### Interactive REPL

```bash
npm run cli
```

Starts an interactive loop where you type messages and see responses:

```
Construct interactive mode. Type "exit" or Ctrl+C to quit.

you> What do you remember about my work schedule?

construct> Based on my memories, you typically work from...

you> exit
```

The REPL uses Node.js `readline` for input. Each message is processed through `processMessage()` with `source: 'cli'` and `externalId: 'cli'`, creating a single persistent CLI conversation.

### One-Shot

```bash
npm run cli -- "What's the weather like?"
```

Sends a single message, prints the response, and exits. Uses the positional `message` argument.

### Direct Tool Invocation

```bash
npm run cli -- --tool memory_recall --args '{"query": "work schedule"}'
```

Bypasses the agent entirely and invokes a specific tool with JSON arguments. Useful for testing and debugging tools.

When using `--tool` mode:
1. All tools from all packs are loaded (no embedding selection -- `queryEmbedding` is `undefined`)
2. The named tool is found and executed directly
3. The raw output is printed

If the tool name is not found, available tool names are listed.

## Command Definition

Using Citty's `defineCommand`:

```typescript
args: {
  message: { type: 'positional', required: false },  // One-shot message
  tool:    { type: 'string' },                        // Direct tool name
  args:    { type: 'string', alias: 'a' },            // JSON args for --tool
}
```

## CLI vs. Telegram

| Aspect | CLI | Telegram |
|--------|-----|----------|
| Source | `'cli'` | `'telegram'` |
| External ID | `'cli'` (fixed) | Chat ID |
| Telegram tools | Return `null` (no TelegramContext) | Fully functional |
| Typing indicator | None | Auto-refreshing |
| Output format | Plain text | Markdown-to-HTML |
| Self-deploy | Respects `isDev` flag | Respects `isDev` flag |

## Startup

The CLI runs migrations on startup, same as the main entry point. It does **not** start the scheduler or Telegram bot -- it only creates the database connection and processes messages.

## Related Documentation

- [Agent System](./agent.md) -- The shared processMessage() pipeline
- [Tool System](./tools.md) -- Tools invoked via --tool mode
- [Development Workflow](./../guides/development.md) -- npm run scripts
