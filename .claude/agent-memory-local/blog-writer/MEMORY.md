# Blog Writer Memory

## Articles Written

1. **Construct's Memory System: An Architecture Overview** (`.blog/memory-architecture-overview.md`)
   - Topic: High-level overview of the entire memory system — the "read this first" article
   - Angle: Two kinds of memory (explicit vs. observational), the dual pipeline design (write vs. read), how a message flows through the system, graceful degradation from day one
   - Explicitly references the Observer/Reflector/Graph and Three Ways deep-dives as companion articles
   - Mentions Mastra's Observational Memory as the inspiration

2. **Observer, Reflector, Graph: How Construct Compresses Conversation Into Memory**
   - Topic: The observational memory pipeline (observer → reflector → graph extraction)
   - Key systems: `src/memory/observer.ts`, `src/memory/reflector.ts`, `src/memory/graph/`, `src/memory/index.ts`
   - Angle: The three-tier memory compression architecture — ephemeral messages → observations → reflections → graph nodes
   - Notable: `generation` field tracks how many reflector rounds an observation has survived; SQLite rowid watermark trick for insertion-order safety

3. **Three Ways to Find a Memory: FTS5, Embeddings, and Graph Traversal in a Personal AI**
   - Topic: The memory _retrieval_ side — passive vs. active retrieval, FTS5/embedding waterfall, graph expansion
   - Key systems: `src/db/queries.ts` (`recallMemories`), `src/tools/core/memory-recall.ts`, `src/memory/graph/queries.ts`, `src/agent.ts` (passive injection), `src/system-prompt.ts` (preamble)
   - Angle: Three search modes (FTS5, cosine similarity, graph traversal) combined in a single retrieval pipeline; passive auto-injection vs. active tool-invoked recall
   - Notable: queryEmbedding is generated once and reused for both memory recall AND tool pack selection; matchType field (`fts5`/`embedding`/`graph`) lets agent reason about retrieval confidence
   - Updated 2026-02-27: Removed LIKE fallback — recallMemories is now FTS5 → embeddings only; LIKE still used in searchNodes for graph node lookup (internal detail, not a memory retrieval mode)

4. **Pre-Filtering vs. Retrieval: How Construct Routes Tools Before the Model Sees Them** (`.blog/tool-selection-via-embeddings.md`)
   - Topic: Construct's specific design choices for embedding-based tool routing vs. the established prior art
   - Key systems: `src/tools/packs.ts` (`selectPacks`, `initPackEmbeddings`), `src/extensions/embeddings.ts` (`selectSkills`, `selectDynamicPacks`), `src/agent.ts` (single `queryEmbedding` drives memory + tool packs + skills)
   - Angle: Pre-filtering (model never sees excluded tools) vs. on-demand retrieval (Claude's Tool Search Tool, LlamaIndex); pack-level vs. tool-level embedding granularity; asymmetric failure semantics for tools (fail open) vs. skills (fail closed)
   - Prior art named: Claude Tool Search Tool (BM25+embeddings, on-demand), LlamaIndex QueryEngineTool, arXiv:2511.01854 (Tool-to-Agent Retrieval), ToolScope, arXiv:2602.17046 (Dynamic System Instructions — closest match), ToolScale paradigm
   - Rewritten 2026-02-26: Previous version framed embedding routing as novel; rewrite acknowledges established prior art and focuses on Construct's specific design decisions

5. **The 15-Step Assembly Line: How Construct Builds a Response** (`.blog/process-message-pipeline.md`)
   - Topic: `processMessage()` as the central orchestration function — full end-to-end walkthrough
   - Angle: Linear assembly metaphor; single queryEmbedding reused for memory recall + tool packs + skills; preamble-in-user-message design for prompt caching; fire-and-forget post-response memory hooks
   - Key files: `src/agent.ts`, `src/system-prompt.ts`, `src/tools/packs.ts`, `src/telegram/bot.ts`, `cli/index.ts`, `src/extensions/index.ts`, `src/scheduler/index.ts`

6. **The AI That Patches Itself: Building a Safe Self-Modification Loop** (`.blog/self-aware-tooling.md`)
   - Topic: The self-aware tooling system — read, edit, test, deploy pipeline
   - Key systems: `src/tools/self/self-read.ts`, `src/tools/self/self-edit.ts`, `src/tools/self/self-test.ts`, `src/tools/self/self-deploy.ts`, `src/tools/packs.ts`
   - Angle: Allowlist-based security model, uniqueness-required edits, sequential deploy gate with auto-rollback
   - Notable: Deploy disabled in dev via `ctx.isDev ? null : createSelfDeployTool()` factory pattern; double test run (agent-invoked + deploy-internal); auto-rollback with named git tag recovery point; in-process rate limiter resets on restart
   - Updated 2026-02-26: Added "The Extension Authoring Loop" section — agent writes extensions/tools/ or extensions/skills/ via self_edit_source, calls extension_reload, provisions secrets via secret_store, uses the new tool in the same conversation

## Code Patterns Noted (potential future topics)

- **Embedding-based tool pack selection** — WRITTEN (see article 4 above)
- **Self-modifying agent with rate-limited deploy** — WRITTEN (see article 6 above)
- **Static system prompt + dynamic preamble split** (`src/system-prompt.ts`): System prompt is kept static (cacheable) while per-request dynamic context (observations, memories, skills, date) is prepended to the first user message. Clear architectural decision for LLM prompt caching.
- **jiti dynamic TypeScript loading** (`src/extensions/loader.ts`): Extension tools are .ts files loaded at runtime via jiti without a compile step. The node_modules symlink trick allows extension tools to import project deps.
- **node_modules symlink trick** in `ensureNodeModulesLink()`: walks up the directory tree from the compiled file's location to find node_modules, then symlinks it into the extensions directory.

## Deleted Articles

- **extension-system.md** — deleted 2026-02-26. All unique content folded into tool-selection-via-embeddings.md (ecosystem framing, jiti internals, skills-vs-rules contrast, filesystem-as-schema, threshold tradeoffs) and self-aware-tooling.md (extension authoring loop).

7. **When You Can't Trust the Answer: Building a Memory Explorer for a Multi-Stream AI** (`.blog/drafts/graph-explorer-observability.md`)
   - Topic: The graph explorer web app and the observability/debugging problem it solves
   - Angle: Multi-stream memory retrieval (observer/reflector/FTS5/embeddings/graph) creates opacity that conversational testing can't pierce; explorer is a direct SQLite read-only UI that makes the system auditable
   - Key systems: `explorer/server.ts` (Hono), `explorer/routes/` (memories/graph/observations/stats), `explorer/web/src/` (React + d3-force canvas)
   - Notable: matchType field surfaces retrieval path; bidirectional memory↔graph-node linkage; ObservationTimeline shows superseded obs + generation count; expandNode mirrors agent's graph traversal

8. **One Memory Package, Three Apps** (`.blog/drafts/cairn-across-the-stack.md`)
   - Topic: cairn as a shared package across Construct, Cortex, Synapse, and Optic (Rust TUI)
   - Angle: Each app uses cairn differently — full pipeline (Construct), market data as conversation (Cortex), ignored (Synapse), raw SQL read (Optic)
   - Key code: `apps/cortex/src/pipeline/loop.ts` (feed prices/news through cairn), `apps/cortex/src/pipeline/analyzer.ts` (recall + graph traversal before signal gen), `apps/optic/src/db.rs` (direct SQL on cairn tables), `apps/synapse/src/engine/loop.ts` (reads Cortex signals, no cairn)
   - Notable: Kysely invariance workaround (accept `Kysely<any>`, cast internally); Cortex writes signals back as cairn memories (feedback loop); Optic `weight > 1.0` filter uses cairn graph edge weight as noise gate; `commands` table as TUI-to-daemon IPC
   - Synapse is `apps/synapse/` — a paper execution engine that polls Cortex signals and manages portfolio state with stop-loss/drawdown halts

9. **Building an Inbox for Agents: Construct's Federation Design** (`.blog/drafts/inbox-federation.md`)
   - Topic: Inbox federation design walkthrough (not yet implemented — forward-looking article)
   - Angle: The trust model is the interesting part: one-directional trust, order-independent handshake, deny-by-default, personality stripping for agent-to-agent comms, reusing processMessage() as inbox processor
   - Key systems: `inbox/identity.ts` (Ed25519 via node:crypto), `inbox/server.ts` (Hono POST /inbox), `peers` + `inbox_messages` tables, `getInboxSystemPrompt()`, scheduler integration
   - Notable: "share availability windows, not reasons" privacy rule; `mutual` flag is informational not a gate; phase 2 scoped out (service peers, per-peer permissions, persistent nonce log)

## Areas to Avoid (already covered or thin)

- General "how Construct works" tour — too broad
