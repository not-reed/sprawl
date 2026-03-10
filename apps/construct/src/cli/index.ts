import { defineCommand, runMain } from "citty";
import { createInterface } from "node:readline";
import type { Kysely } from "kysely";
import { createDb } from "@repo/db";
import { generateEmbedding, MemoryManager, processMemoryForGraph } from "@repo/cairn";
import type { Database } from "../db/schema.js";
import { runMigrations } from "../db/migrate.js";
import { env } from "../env.js";
import { processMessage, isDev } from "../agent.js";
import { selectAndCreateTools } from "../tools/packs.js";
import { initExtensions, selectAndCreateDynamicTools } from "../extensions/index.js";

const main = defineCommand({
  meta: {
    name: "construct",
    description: "Construct CLI — personal braindump companion",
  },
  args: {
    message: {
      type: "positional",
      description: "One-shot message to send to the agent",
      required: false,
    },
    tool: {
      type: "string",
      description: "Invoke a specific tool directly (for testing)",
    },
    args: {
      type: "string",
      alias: "a",
      description: "JSON arguments for --tool",
    },
    reembed: {
      type: "boolean",
      description: "Re-embed all memories and graph nodes using the current EMBEDDING_MODEL",
    },
    backfill: {
      type: "boolean",
      description:
        "Backfill graph memory, embeddings, observer, and reflector for all existing data",
    },
  },
  async run({ args }) {
    // Run migrations
    await runMigrations(env.DATABASE_URL);

    const { db } = createDb<Database>(env.DATABASE_URL);

    // Re-embed all memories
    if (args.reembed) {
      await reembedAll(db);
      process.exit(0);
    }

    // Backfill graph memory, observer, reflector
    if (args.backfill) {
      await backfillAll(db);
      process.exit(0);
    }

    // Direct tool invocation mode
    if (args.tool) {
      await runTool(db, args.tool, args.args);
      process.exit(0);
    }

    // One-shot mode
    if (args.message) {
      const response = await processMessage(db, args.message, {
        source: "cli",
        externalId: "cli",
      });
      console.log(response.text);
      process.exit(0);
    }

    // Interactive REPL mode
    console.log('Construct interactive mode. Type "exit" or Ctrl+C to quit.\n');

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      rl.question("you> ", async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === "exit" || trimmed === "quit") {
          rl.close();
          process.exit(0);
        }

        try {
          const response = await processMessage(db, trimmed, {
            source: "cli",
            externalId: "cli",
          });
          console.log(`\nconstruct> ${response.text}\n`);
        } catch (err) {
          console.error("Error:", err);
        }

        prompt();
      });
    };

    prompt();
  },
});

async function runTool(db: Kysely<Database>, toolName: string, argsJson?: string) {
  // Load all tools (no query embedding → all packs selected)
  const ctx = {
    db,
    chatId: "cli",
    apiKey: env.OPENROUTER_API_KEY,
    projectRoot: env.PROJECT_ROOT,
    dbPath: env.DATABASE_URL,
    timezone: env.TIMEZONE,
    tavilyApiKey: env.TAVILY_API_KEY,
    logFile: env.LOG_FILE,
    isDev,
  };
  const builtinTools = selectAndCreateTools(undefined, ctx);

  // Also load dynamic extension tools
  await initExtensions(env.EXTENSIONS_DIR, env.OPENROUTER_API_KEY, db, env.EMBEDDING_MODEL);
  const dynamicTools = selectAndCreateDynamicTools(undefined, ctx);

  const tools = [...builtinTools, ...dynamicTools];
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    const available = tools.map((t) => t.name).join(", ");
    console.error(`Unknown tool: ${toolName}`);
    console.error(`Available tools: ${available}`);
    process.exit(1);
  }

  const parsedArgs = argsJson ? JSON.parse(argsJson) : {};

  console.log(`Running tool: ${toolName}`);
  console.log(`Args: ${JSON.stringify(parsedArgs, null, 2)}\n`);

  const result = await tool.execute(`cli-${Date.now()}`, parsedArgs);
  console.log(result.output);
}

async function reembedAll(db: Kysely<Database>) {
  const model = env.EMBEDDING_MODEL;
  console.log(`Re-embedding all data using model: ${model}\n`);

  // Phase 1 — Memories
  console.log("=== Phase 1: Memories ===");

  const memories = await db
    .selectFrom("memories")
    .select(["id", "content"])
    .where("archived_at", "is", null)
    .execute();

  console.log(`Found ${memories.length} memories to re-embed`);

  let m_success = 0;
  let m_failed = 0;

  await pooled(memories, 10, async (memory) => {
    try {
      const embedding = await generateEmbedding(env.OPENROUTER_API_KEY, memory.content, model);
      await db
        .updateTable("memories")
        .set({ embedding: JSON.stringify(embedding) })
        .where("id", "=", memory.id)
        .execute();
      m_success++;
    } catch (err) {
      m_failed++;
      console.error(`\n  Failed memory ${memory.id}: ${err instanceof Error ? err.message : err}`);
    }
    process.stdout.write(`\r  ${m_success + m_failed}/${memories.length} (${m_failed} failed)`);
  });

  if (memories.length > 0) console.log();
  console.log(`Done: ${m_success} re-embedded, ${m_failed} failed`);

  // Phase 2 — Graph nodes
  console.log("\n=== Phase 2: Graph nodes ===");

  const nodes = await db
    .selectFrom("graph_nodes")
    .select(["id", "display_name", "description"])
    .execute();

  console.log(`Found ${nodes.length} graph nodes to re-embed`);

  let n_success = 0;
  let n_failed = 0;

  await pooled(nodes, 10, async (node) => {
    try {
      const text = node.description
        ? `${node.display_name}: ${node.description}`
        : node.display_name;
      const embedding = await generateEmbedding(env.OPENROUTER_API_KEY, text, model);
      await db
        .updateTable("graph_nodes")
        .set({ embedding: JSON.stringify(embedding) })
        .where("id", "=", node.id)
        .execute();
      n_success++;
    } catch (err) {
      n_failed++;
      console.error(`\n  Failed node ${node.id}: ${err instanceof Error ? err.message : err}`);
    }
    process.stdout.write(`\r  ${n_success + n_failed}/${nodes.length} (${n_failed} failed)`);
  });

  if (nodes.length > 0) console.log();
  console.log(`Done: ${n_success} re-embedded, ${n_failed} failed`);

  console.log("\n=== Re-embed complete ===");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 2000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(delayMs);
    }
  }
}

/** Run async tasks with bounded concurrency. Calls onProgress after each completion. */
async function pooled<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  async function next(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
}

async function backfillAll(db: Kysely<Database>) {
  if (!env.MEMORY_WORKER_MODEL) {
    console.error("Error: MEMORY_WORKER_MODEL must be set for backfill");
    process.exit(1);
  }

  const workerConfig = {
    apiKey: env.OPENROUTER_API_KEY,
    model: env.MEMORY_WORKER_MODEL,
    extraBody: { reasoning: { max_tokens: 1 } },
  };
  const embeddingOpts = { apiKey: env.OPENROUTER_API_KEY, embeddingModel: env.EMBEDDING_MODEL };
  const mm = new MemoryManager(db, {
    workerConfig,
    embeddingModel: env.EMBEDDING_MODEL,
    apiKey: env.OPENROUTER_API_KEY,
  });

  // Phase 1 — Graph extraction for memories with no edges
  console.log("\n=== Phase 1: Graph extraction ===");

  const memoriesWithoutEdges = await db
    .selectFrom("memories")
    .select(["id", "content"])
    .where("archived_at", "is", null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("graph_edges")
            .select("id")
            .whereRef("graph_edges.memory_id", "=", "memories.id"),
        ),
      ),
    )
    .execute();

  console.log(`Found ${memoriesWithoutEdges.length} memories without graph edges`);

  let p1Success = 0;
  let p1Failed = 0;

  await pooled(memoriesWithoutEdges, 5, async (mem) => {
    try {
      await withRetry(() =>
        processMemoryForGraph(db, workerConfig, mem.id, mem.content, embeddingOpts),
      );
      p1Success++;
    } catch (err) {
      p1Failed++;
      console.error(`\n  Failed memory ${mem.id}: ${err instanceof Error ? err.message : err}`);
    }
    process.stdout.write(
      `\r  ${p1Success + p1Failed}/${memoriesWithoutEdges.length} (${p1Failed} failed)`,
    );
  });

  if (memoriesWithoutEdges.length > 0) console.log();
  console.log(`Done: ${p1Success} extracted, ${p1Failed} failed`);

  // Phase 2 — Graph node embeddings
  console.log("\n=== Phase 2: Graph node embeddings ===");

  const nodesWithoutEmbeddings = await db
    .selectFrom("graph_nodes")
    .select(["id", "display_name", "description"])
    .where("embedding", "is", null)
    .execute();

  console.log(`Found ${nodesWithoutEmbeddings.length} nodes without embeddings`);

  let p2Success = 0;
  let p2Failed = 0;

  await pooled(nodesWithoutEmbeddings, 10, async (node) => {
    try {
      const text = node.description
        ? `${node.display_name}: ${node.description}`
        : node.display_name;
      const embedding = await generateEmbedding(env.OPENROUTER_API_KEY, text, env.EMBEDDING_MODEL);
      await db
        .updateTable("graph_nodes")
        .set({ embedding: JSON.stringify(embedding) })
        .where("id", "=", node.id)
        .execute();
      p2Success++;
    } catch (err) {
      p2Failed++;
      console.error(`\n  Failed node ${node.id}: ${err instanceof Error ? err.message : err}`);
    }
    process.stdout.write(
      `\r  ${p2Success + p2Failed}/${nodesWithoutEmbeddings.length} (${p2Failed} failed)`,
    );
  });

  if (nodesWithoutEmbeddings.length > 0) console.log();
  console.log(`Done: ${p2Success} embedded, ${p2Failed} failed`);

  // Phase 3 — Observer
  console.log("\n=== Phase 3: Observer ===");

  const conversations = await db.selectFrom("conversations").select("id").execute();

  console.log(`Found ${conversations.length} conversations`);

  let p3Triggered = 0;
  let p3Skipped = 0;
  let p3Failed = 0;

  for (let i = 0; i < conversations.length; i++) {
    try {
      const ran = await mm.runObserver(conversations[i].id);
      if (ran) p3Triggered++;
      else p3Skipped++;
      process.stdout.write(
        `\r  ${i + 1}/${conversations.length} (${p3Triggered} triggered, ${p3Skipped} skipped, ${p3Failed} failed)`,
      );
    } catch (err) {
      p3Failed++;
      process.stdout.write(
        `\r  ${i + 1}/${conversations.length} (${p3Triggered} triggered, ${p3Skipped} skipped, ${p3Failed} failed)`,
      );
      console.error(
        `\n  Failed conversation ${conversations[i].id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (conversations.length > 0) console.log();
  console.log(`Done: ${p3Triggered} triggered, ${p3Skipped} below threshold, ${p3Failed} failed`);

  // Phase 4 — Reflector
  console.log("\n=== Phase 4: Reflector ===");
  console.log(`Processing ${conversations.length} conversations`);

  let p4Triggered = 0;
  let p4Skipped = 0;
  let p4Failed = 0;

  for (let i = 0; i < conversations.length; i++) {
    try {
      const ran = await mm.runReflector(conversations[i].id);
      if (ran) p4Triggered++;
      else p4Skipped++;
      process.stdout.write(
        `\r  ${i + 1}/${conversations.length} (${p4Triggered} triggered, ${p4Skipped} skipped, ${p4Failed} failed)`,
      );
    } catch (err) {
      p4Failed++;
      process.stdout.write(
        `\r  ${i + 1}/${conversations.length} (${p4Triggered} triggered, ${p4Skipped} skipped, ${p4Failed} failed)`,
      );
      console.error(
        `\n  Failed conversation ${conversations[i].id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (conversations.length > 0) console.log();
  console.log(`Done: ${p4Triggered} triggered, ${p4Skipped} below threshold, ${p4Failed} failed`);

  console.log("\n=== Backfill complete ===");
}

runMain(main);
