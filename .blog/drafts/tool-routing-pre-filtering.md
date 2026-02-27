---
title: "Pre-Filtering vs. Retrieval: How Construct Routes Tools Before the Model Sees Them"
date: 2026-02-26
tags: [embeddings, tools, routing, cosine-similarity, architecture]
description: "How Construct uses a single embedding call to pre-filter tools before the model sees them, with a fail-open design."
---

# Pre-Filtering vs. Retrieval: How Construct Routes Tools Before the Model Sees Them

Using embeddings to decide which tools a language model should see is not a new idea. Anthropic has a cookbook recipe for it. LlamaIndex has `QueryEngineTool` with embedding-based retrieval as a core abstraction. Academic work on tool routing (ToolScope, Tool-to-Agent Retrieval [arXiv:2511.01854], Dynamic System Instructions and Tool Exposure [arXiv:2602.17046]) has been building up for a couple of years. The general paradigm even has a name in the literature: ToolScale.

So when I say Construct uses embeddings to select tools, that's not the interesting part. What's interesting is the specific shape of the implementation: where in the pipeline the selection happens, how failures propagate, what the routing granularity is, and what else rides on the same embedding call.

## Pre-Filtering, Not Retrieval

The dominant pattern in the literature is **retrieval**: the model encounters a query, determines it needs a tool, and then calls a search function to find the right one. This is how Claude's Tool Search Tool works: when Claude has hundreds of MCP servers loaded, it can invoke a search with BM25 or embeddings to locate the specific tool it needs on-demand.

Construct does something different: **pre-filtering**. Before the model ever sees the user's message, the system decides which tool packs to load into context. The model operates on a reduced tool list with no awareness that other tools exist. It can't ask for excluded tools because they're invisible to it.

This is closer to the "Dynamic System Instructions" paper (arXiv:2602.17046), which specifically addresses the problem of re-ingesting large tool catalogs every turn. The tradeoffs are different from retrieval: pre-filtering is simpler and doesn't require the model to reason about what tools might exist, but it means a routing mistake is invisible to the model. It can't recover by searching for what it needs.

## The Pack Abstraction

The unit of selection is a tool pack: a named group of related tools with a plain-English description and an `alwaysLoad` flag.

```typescript
// src/tools/packs.ts
export interface ToolPack {
  name: string
  description: string
  alwaysLoad: boolean
  factories: ToolFactory[]
}

export const TOOL_PACKS: ToolPack[] = [
  {
    name: 'core',
    description: 'Long-term memory storage and recall, scheduled reminders and recurring tasks',
    alwaysLoad: true,
    factories: [ /* memory_store, memory_recall, schedule_create, ... */ ],
  },
  {
    name: 'web',
    description: 'Search the web, read web pages, fetch news, weather, documentation, and articles',
    alwaysLoad: false,
    factories: [ /* web_read, web_search */ ],
  },
  {
    name: 'self',
    description: 'Read, edit, test, and deploy own source code. View service logs and system health. Self-modification.',
    alwaysLoad: false,
    factories: [ /* self_read_source, self_edit_source, self_run_tests, self_deploy, ... */ ],
  },
]
```

Most approaches in the literature embed individual tools. Construct embeds one description per group. This is coarser (a pack description has to cover the query space for all the tools it contains), but it's simpler, and for a personal assistant with a handful of packs, the loss of precision doesn't matter much.

At startup, every non-`alwaysLoad` pack gets its description embedded and stored:

```typescript
// src/tools/packs.ts
export async function initPackEmbeddings(apiKey: string, embeddingModel?: string): Promise<void> {
  const packsToEmbed = TOOL_PACKS.filter((p) => !p.alwaysLoad)

  const results = await Promise.allSettled(
    packsToEmbed.map(async (pack) => {
      const embedding = await generateEmbedding(apiKey, pack.description, embeddingModel)
      packEmbeddings.set(pack.name, embedding)
    }),
  )

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      agentLog.warning`Failed to embed pack "${packsToEmbed[i].name}": will always load.`
    }
  }
}
```

`Promise.allSettled` rather than `Promise.all` matters here: if the embedding API is down at startup, the system logs warnings and continues. Pack embeddings are missing, but there's a fallback for that.

## Three Fallback Rules Before Cosine Similarity

The selection logic is a pure function:

```typescript
// src/tools/packs.ts
export function selectPacks(
  queryEmbedding: number[] | undefined,
  packs: ToolPack[],
  embeddings: Map<string, number[]>,
  threshold = 0.3,
): ToolPack[] {
  if (!queryEmbedding) {
    return packs  // no embedding → load everything
  }

  return packs.filter((pack) => {
    if (pack.alwaysLoad) return true

    const packEmb = embeddings.get(pack.name)
    if (!packEmb) return true  // no embedding → load it

    const similarity = cosineSimilarity(queryEmbedding, packEmb)
    return similarity >= threshold
  })
}
```

Before cosine similarity is ever computed, three rules have already decided some packs:

1. If there's no query embedding (API failure at message time), load everything.
2. If a pack has no cached embedding (its startup init failed), load it.
3. `alwaysLoad` packs are unconditional regardless of what the query says.

Every failure path in this function defaults to loading more tools, not fewer. The system errs toward an overpowered model rather than a crippled one. This is a deliberate design position: a false positive (loading the web pack for a message that didn't need it) costs tokens; a false negative (not loading the self pack when the user asks to edit a file) costs the agent its ability to do the job.

The 0.3 threshold reflects the same position. It's permissive enough that short or ambiguous messages tend to trigger multiple packs. There's no feedback loop. The system doesn't observe which packs actually got used and adjust the threshold for ones that consistently load but rarely exercise their tools.

Because `selectPacks` is a pure function that accepts the embedding map as a parameter, the test suite can verify routing logic with synthetic three-dimensional vectors instead of real API calls:

```typescript
// src/tools/__tests__/packs.test.ts
const packEmbeddings = new Map<string, number[]>([
  ['web', [1, 0, 0]],
  ['self', [0, 1, 0]],
])

it('selects high-similarity packs and excludes low-similarity', () => {
  const queryEmbedding = [1, 0, 0]  // points toward web, orthogonal to self
  const selected = selectPacks(queryEmbedding, allPacks, packEmbeddings, 0.3)

  const names = selected.map((p) => p.name)
  expect(names).toContain('web')        // cosine similarity = 1.0
  expect(names).not.toContain('self')   // cosine similarity = 0
})
```

The geometry is the test. No mocking required.

## One Embedding, Three Consumers

When a message arrives, `processMessage()` generates exactly one query embedding:

```typescript
// src/agent.ts
let queryEmbedding: number[] | undefined
let relevantMemories: Array<{ content: string; category: string; score?: number }> = []
try {
  queryEmbedding = await generateEmbedding(env.OPENROUTER_API_KEY, message, env.EMBEDDING_MODEL)
  const results = await recallMemories(db, message, {
    limit: 5,
    queryEmbedding,
    similarityThreshold: 0.4,
  })
  // ...filter and assign relevantMemories
} catch {
  // queryEmbedding stays undefined → graceful fallback across all consumers
}
```

That same vector then routes two more systems:

```typescript
// src/agent.ts
const selectedSkills = selectSkills(queryEmbedding)         // skill injection
const builtinTools = selectAndCreateTools(queryEmbedding, toolCtx)  // built-in tool packs
const dynamicTools = selectAndCreateDynamicTools(queryEmbedding, toolCtx)  // extension packs
```

One API call drives memory retrieval, tool pack selection, and skill selection. If the embedding call fails, all three degrade together with consistent behavior: memory search skips semantic results, every tool pack loads, and no skills inject. Consistent degradation across shared infrastructure is easier to reason about than three independently failing systems.

## Tools and Skills Fail Differently

Skills are Markdown instruction documents, not code, but contextual guidance injected into the prompt when the message matches their description. Each skill has a YAML frontmatter block:

```yaml
---
name: daily-standup
description: Structured daily standup format with blockers and priorities
---
```

At reload time, skills are embedded as `"${name}: ${description}"`. When a message arrives, the same `queryEmbedding` selects relevant skills, with a slightly higher threshold (0.35 vs 0.3) and a cap of three, since skills add to context rather than unlock capabilities.

But the critical difference is the failure semantics. From `src/extensions/embeddings.ts`:

```typescript
export function selectSkills(
  queryEmbedding: number[] | undefined,
  skills: Skill[],
  threshold = 0.35,
  maxSkills = 3,
): Skill[] {
  // No query embedding → return nothing
  if (!queryEmbedding) return []

  const scored = skills
    .map((skill) => {
      const emb = skillEmbeddings.get(skill.name)
      if (!emb) return { skill, score: 0 }  // no embedding → score 0 (excluded)
      return { skill, score: cosineSimilarity(queryEmbedding, emb) }
    })
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSkills)

  return scored.map((s) => s.skill)
}
```

Compare this to `selectPacks`: when there's no query embedding, tools load everything; skills load nothing. When a pack has no cached embedding, it loads anyway; a skill with no cached embedding scores 0 and is excluded.

The asymmetry is intentional. Tools are capabilities. If the self pack doesn't load when the user asks to edit a file, the agent is broken. Skills are refinements. If a standup skill doesn't inject when the user says "let's do standup," the agent produces a slightly less structured response. The cost of a missing tool is an agent that can't do its job. The cost of a missing skill is an agent that does its job without a specific style guide.

## Extension Tools Are First-Class in the Router

User- and agent-authored TypeScript tools loaded from `$EXTENSIONS_DIR/tools/` go through the exact same routing:

```typescript
// src/extensions/loader.ts
if (entry.isFile() && extname(entry.name) === '.ts') {
  const tool = await loadSingleToolFile(fullPath, toolCtx, availableSecrets)
  if (tool) {
    const packName = `ext:${basename(entry.name, '.ts')}`
    packs.push({
      name: packName,
      description: tool.description,  // tool's own description becomes the embedding target
      alwaysLoad: false,
      factories: [() => tool],
    })
  }
}
```

At reload time, extension pack descriptions get embedded into a separate cache (`dynamicPackEmbeddings`). When a message arrives, `selectDynamicPacks` applies the same `selectPacks` logic against that cache. A weather tool with description "Get current weather conditions and forecasts for any location" will score highly against weather queries. A music tool won't. No configuration required beyond writing the tool with a good description.

Built-in packs have no advantage over extension packs in the router. The description is the routing key, and both compete on equal terms.

## What the Threshold Doesn't Do

The 0.3 threshold is hardcoded and applies uniformly. There's no per-pack tuning, no way to mark one pack as higher priority than another, no adjustment based on observed usage. A pack with an ambiguous description (something that could be described as "journal entries" or "daily logs" or "notes") might miss messages it should catch, or catch messages it shouldn't.

Short messages are a particular weak point. "What's up?" has weak semantic signal, and the cosine similarities end up close enough that multiple packs load based on noise rather than genuine relevance. A fallback to a smaller static set for very-short messages would help, but the system doesn't do this.

The routing also adds latency. The embedding call has to complete before tool selection or memory retrieval can begin. For a personal assistant where the user expects a few seconds of processing, this is fine. For a latency-sensitive production system, you'd want to parallelize or accept a static tool list.

## The Decisions Worth Keeping

The interesting parts of this design aren't the use of embeddings for tool routing. That's table stakes. The decisions worth examining are:

**Pre-filtering vs. retrieval.** Hiding excluded tools from the model entirely changes what the model can do. It can't ask for a tool it doesn't know exists, which means routing mistakes are silent. Whether that's acceptable depends on your trust in the router's precision.

**Fail open.** Every failure path in the tools system defaults to loading more, not less. This is a position, not a default. Failing closed (load nothing) would be safer in a different sense, since the model won't have access to tools it shouldn't. But for a personal assistant where the primary concern is usefulness, failing open is the right call.

**Asymmetric failure modes for tools vs. instruction injection.** If you have two kinds of context additions (capabilities and guidance), the consequences of missing each are different, and the failure semantics should reflect that difference.

**Pure selection logic.** Keeping `selectPacks` free of side effects means the routing geometry is directly testable. You don't need a working embedding API to verify that a query pointing at web coordinates correctly excludes the self pack.
