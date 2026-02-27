---
title: "How Construct Builds a Response: The processMessage Pipeline"
date: 2026-02-26
tags: [agent, pipeline, architecture, context-assembly]
description: "A walkthrough of Construct's processMessage() function and the sequential assembly pipeline behind every response."
---

# How Construct Builds a Response: The processMessage Pipeline

Every message Construct receives, whether it arrives via Telegram at 11pm or as a CLI one-liner during a debugging session, flows through the same function: `processMessage()` in `src/agent.ts`. It's 220 lines of sequential setup followed by a single `agent.prompt()` call, and understanding its structure reveals most of the interesting architectural decisions in the project.

The function is an assembly line. Each step gathers or constructs something the agent needs, hands it to the next step, and by the time the prompt fires, the agent has a fully configured view of the world.

## The Dual Entry Points

Construct has two entry points that share exactly one thing: the `processMessage` call.

From Telegram (`src/telegram/bot.ts`):
```typescript
const response = await processMessage(db, ctx.message.text, {
  source: 'telegram',
  externalId: chatId,
  chatId,
  telegram: telegramCtx,
  replyContext,
  incomingTelegramMessageId: ctx.message.message_id,
})
```

From the CLI (`cli/index.ts`):
```typescript
const response = await processMessage(db, trimmed, {
  source: 'cli',
  externalId: 'cli',
})
```

The CLI omits `telegram`, `replyContext`, and `incomingTelegramMessageId` entirely. Everything downstream treats these as optional and degrades gracefully. Telegram-specific tools simply don't get created when there's no Telegram context, and the preamble skips the reply annotation. The `source` field ends up in the database, in the usage tracking, and in the context preamble so the agent knows which interface it's talking through.

There's also a third path: the scheduler fires reminders by sending a Telegram message directly via the Bot API rather than going through `processMessage`. The agent created the schedule, but the scheduler fires it as a direct bot message. Simpler, no LLM cost at fire time, but the agent can't dynamically adjust the reminder content when it fires.

## Steps 1–3: Identity and Context

The function opens with three quick lookups that establish who is talking and what the recent conversation looked like.

**Step 1** resolves the conversation. Construct stores conversations by source + external ID, so the Telegram chat and the CLI session are distinct conversation threads with independent histories.

**Steps 2–3** invoke `MemoryManager.buildContext()`, which returns the conversation's observational context. If enough previous messages have been compressed into observations, those become the stable "prefix" context; the uncompressed recent messages become the "active suffix". If no observations exist yet, the function falls back to the last 20 raw messages. This is the graduated memory system: no behavioral difference until the conversation gets long enough to warrant compression.

`buildContext()` also applies a token budget (8,000 tokens) to observation rendering. If total observation tokens fit, the fast path skips any sorting overhead. If they exceed the budget, priority-based eviction kicks in and the debug log includes the eviction count alongside the observation and active message counts. The evicted observations aren't lost; they're still reachable through `memory_recall`.

## Steps 4–6: The Embedding That Drives Everything

Step 4 generates an embedding for the incoming message:

```typescript
queryEmbedding = await generateEmbedding(env.OPENROUTER_API_KEY, message, env.EMBEDDING_MODEL)
```

This single vector gets reused for three separate purposes, each a few lines apart:

1. **Memory recall**: finding semantically relevant long-term memories to inject into context
2. **Tool pack selection**: deciding which built-in tool packs (web, self-modification, etc.) to load
3. **Skill and dynamic tool selection**: choosing which user-defined skills and extension tools to activate

One embedding, three jobs. The failure handling matters here too: if the embedding API call fails, `queryEmbedding` stays `undefined`, and every downstream consumer has an explicit fallback: load all packs, load all extension tools, skip skill injection. The agent degrades to a slightly less targeted tool set rather than failing.

## Step 6: The Preamble: Dynamic Context in User-Message Position

An important design choice. The system prompt is kept entirely static. It's the same text every request, enabling LLM provider-side prompt caching. Dynamic context (current time, memories, observations, active skills) goes elsewhere.

Where? Prepended to the first user message:

```typescript
const preamble = buildContextPreamble({
  timezone: env.TIMEZONE,
  source: opts.source,
  dev: isDev,
  observations: observationsText || undefined,
  recentMemories: recentMemories.map(...),
  relevantMemories,
  skills: selectedSkills,
  replyContext: opts.replyContext,
})
// ...later...
await agent.prompt(preamble + message)
```

The result looks like:
```
[Context: Thursday, February 26, 2026, 11:42 PM (America/New_York) | telegram]

[Conversation observations -compressed context from earlier in this conversation]
- User is working on a Rust project...

[Recent memories -use these for context, pattern recognition, and continuity]
- (preference) Prefers dark roast coffee...

[Active skills -follow these instructions when relevant]

### daily-standup
When asked for a standup, ask about blockers first...

What's the weather like tomorrow?
```

The agent sees a single user message with a structured header. It doesn't need special handling for "this is context vs. this is the actual message." It just reads natural language. The tradeoff is that if the preamble is large, it adds to the billable tokens on every request. The upside is that the static system prompt stays cacheable, and the structure of what context is present changes turn-by-turn without prompt engineering gymnastics.

## Steps 7–8: Assembling the Agent

Only now, after all context is gathered, does the agent object get created:

```typescript
const agent = new Agent({
  initialState: {
    systemPrompt: getSystemPrompt(identity),
    model,
  },
})
agent.setTools(tools.map((t) => createPiTool(t)))
```

Tool selection uses the query embedding from step 4 against pre-computed pack embeddings that were generated at startup:

```typescript
const builtinTools = selectAndCreateTools(queryEmbedding, toolCtx)
const dynamicTools = selectAndCreateDynamicTools(queryEmbedding, toolCtx)
```

The `selectPacks` function is pure: it takes embeddings and a threshold, returns a filtered list, and has no side effects. This makes it testable without mocking anything.

Tool factories return `null` when the tool isn't applicable (e.g., Telegram tools when `ctx.telegram` is absent), and the pack builder silently skips nulls. A pack can partially load: you might get the web reader but not the web search tool if no Tavily API key is configured.

The adapter layer between Construct's internal tools and pi-agent's `AgentTool` interface is a thin wrapper:

```typescript
function createPiTool<T extends TSchema>(tool: InternalTool<T>): AgentTool<T, unknown> {
  return {
    name: tool.name,
    label: tool.name.replace(/_/g, ' '),
    description: tool.description,
    parameters: tool.parameters,
    execute: async (toolCallId, params) => {
      const result = await tool.execute(toolCallId, params)
      return {
        content: [{ type: 'text', text: result.output }],
        details: result.details,
      }
    },
  }
}
```

This adapter exists because the project defines its own `InternalTool` interface that all tools implement, decoupled from pi-agent's type expectations. Swapping out the underlying agent framework would touch this one function, not every tool implementation.

## Step 9: Replaying History

Before the prompt fires, the agent gets the conversation history replayed into it:

```typescript
for (const msg of historyMessages) {
  const tgPrefix = msg.telegram_message_id ? `[tg:${msg.telegram_message_id}] ` : ''
  if (msg.role === 'user') {
    agent.appendMessage({ role: 'user', content: tgPrefix + msg.content, timestamp: Date.now() })
  } else if (msg.role === 'assistant') {
    agent.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: tgPrefix + msg.content }],
      // ...usage fields zeroed out...
    })
  }
}
```

The Telegram message ID prefix (`[tg:12345]`) is embedded in the content so the agent can reference specific messages by ID when using `telegram_reply_to`. This works, but it leaks into the assistant's own responses occasionally:

```typescript
// Strip leaked [tg:ID] prefixes from response (LLM sometimes echoes them from history)
responseText = responseText.replace(/\[tg:\d+\]\s*/g, '')
```

It's a band-aid. The proper fix is to use the `name` field or structured metadata on messages so the LLM never sees the pattern in a position it might echo.

## Steps 10–12: Events, Save, Prompt

The agent uses a subscription model for observing what happens during the run:

```typescript
agent.subscribe((event) => {
  if (event.type === 'message_update') {
    if (event.assistantMessageEvent.type === 'text_delta') {
      responseText += event.assistantMessageEvent.delta
    }
  }
  if (event.type === 'message_end') {
    // accumulate usage
  }
  if (event.type === 'tool_execution_end') {
    toolCalls.push({ name: event.toolName, args: undefined, result: String(event.result) })
  }
})
```

The user message is saved to the database before the prompt fires (step 11), then the agent runs (step 12). The agent handles its own tool-call loop internally -`agent.prompt()` starts the turn and `agent.waitForIdle()` blocks until no more tool calls are in-flight. Everything in between happens asynchronously through events.

## Steps 13–15: Save, Track, Fire-and-Forget

After the agent finishes, the assistant's response gets saved, usage is tracked against the conversation source, and then:

```typescript
memoryManager.runObserver(conversationId)
  .then((ran) => {
    if (ran) {
      return memoryManager.runReflector(conversationId)
    }
  })
  .catch((err) => agentLog.error`Post-response observation failed: ${err}`)
```

The observer and reflector run after the response is already returned to the user. They're non-blocking; there's no `await`. The next turn benefits from any observations created, not the current one. If the observer fails, it logs and the conversation continues unchanged. Same pattern as the rest of the codebase: if it fails, keep going.

## Summary

The sequential structure of `processMessage` is a feature. Each step's output feeds the next in a linear dependency chain, and the order makes the data flow obvious. Parallelism is limited: the embedding call blocks until resolved before packs are selected, because the same vector is needed for both. That's a single round-trip cost per message, and the tradeoff for reuse is clear.

The consistent fallback discipline (undefined embedding means load everything, absent Telegram context means no Telegram tools, missing API key means no web search) makes the system composable. You can run Construct without an embedding model, without Tavily, without Telegram. Each capability degrades independently rather than bringing down the whole.

The boundary between "before the prompt" and "after the return" is also a design statement. Everything that needs to be ready before the LLM runs happens synchronously in the pipeline. Everything that benefits the next turn happens asynchronously after. The current turn never waits for memory consolidation, and it never needs to.

---

Relevant files: `src/agent.ts`, `src/system-prompt.ts`, `src/tools/packs.ts`, `src/telegram/bot.ts`, `cli/index.ts`, `src/extensions/index.ts`, `src/scheduler/index.ts`
