import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { env } from "./env.js";
import { createDb } from "@repo/db";
import type { Database } from "./db/schema.js";
import { runMigrations } from "./db/migrate.js";
import { storeMemory, updateMemoryEmbedding } from "./db/queries.js";
import {
  generateEmbedding,
  MemoryManager,
  type WorkerModelConfig,
  estimateTokens,
} from "@repo/cairn";

const MAX_CHUNK_TOKENS = 1500;

function chunkMarkdown(content: string, filename: string): string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let currentHeadings: string[] = [];
  let currentBody: string[] = [];

  function flush() {
    const body = currentBody.join("\n").trim();
    if (!body) return;
    const prefix = currentHeadings.length > 0 ? currentHeadings.join(" > ") + "\n\n" : "";
    const full = prefix + body;

    if (estimateTokens(full) <= MAX_CHUNK_TOKENS) {
      chunks.push(full);
    } else {
      // Split on paragraph boundaries
      const paragraphs = body.split(/\n\n+/);
      let acc = prefix;
      for (const para of paragraphs) {
        const next = acc + (acc.endsWith("\n\n") || acc === prefix ? "" : "\n\n") + para;
        if (estimateTokens(next) > MAX_CHUNK_TOKENS && acc !== prefix) {
          chunks.push(acc.trim());
          acc = prefix + para;
        } else {
          acc = next;
        }
      }
      if (acc.trim() && acc.trim() !== prefix.trim()) {
        chunks.push(acc.trim());
      }
    }
    currentBody = [];
  }

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);

    if (h1) {
      flush();
      currentHeadings = [`# ${h1[1]}`];
    } else if (h2) {
      flush();
      currentHeadings = [currentHeadings[0] ?? `# ${filename}`, `## ${h2[1]}`].filter(Boolean);
    } else if (h3) {
      flush();
      currentHeadings = [
        currentHeadings[0] ?? `# ${filename}`,
        currentHeadings[1],
        `### ${h3[1]}`,
      ].filter(Boolean) as string[];
    } else {
      currentBody.push(line);
    }
  }
  flush();

  return chunks;
}

async function main() {
  const rulesDir = env.RULES_DIR;
  console.log(`Ingesting rules from: ${rulesDir}`);

  await runMigrations(env.DATABASE_URL);
  const { db } = createDb<Database>(env.DATABASE_URL);

  const workerConfig: WorkerModelConfig | null = env.MEMORY_WORKER_MODEL
    ? {
        apiKey: env.OPENROUTER_API_KEY,
        model: env.MEMORY_WORKER_MODEL,
        extraBody: { reasoning: { max_tokens: 1 } },
      }
    : null;
  const mm = new MemoryManager(db, {
    workerConfig,
    embeddingModel: env.EMBEDDING_MODEL,
    apiKey: env.OPENROUTER_API_KEY,
  });

  let files: string[];
  try {
    files = (await readdir(rulesDir)).filter((f) => f.endsWith(".md") || f.endsWith(".txt"));
  } catch {
    console.error(`Rules directory not found: ${rulesDir}`);
    console.log("Create the directory and drop .md or .txt files in it.");
    process.exit(1);
  }

  if (files.length === 0) {
    console.log("No .md or .txt files found in rules directory.");
    process.exit(0);
  }

  let totalChunks = 0;

  for (const file of files) {
    const content = await readFile(join(rulesDir, file), "utf-8");
    const chunks = chunkMarkdown(content, basename(file, ".md"));
    console.log(`${file}: ${chunks.length} chunks`);

    for (const chunk of chunks) {
      const memory = await storeMemory(db, {
        content: chunk,
        category: "rules",
        source: "ingest",
        tags: file,
      });

      try {
        const embedding = await generateEmbedding(
          env.OPENROUTER_API_KEY,
          chunk,
          env.EMBEDDING_MODEL,
        );
        await updateMemoryEmbedding(db, memory.id, embedding);
      } catch (err) {
        console.error(`  Embedding failed for chunk: ${err}`);
      }

      // Graph extraction for NPCs/locations/items
      mm.processStoredMemory(memory.id, memory.content).catch((err) =>
        console.error(`  Graph extraction failed: ${err}`),
      );

      totalChunks++;
    }
  }

  console.log(`Ingested ${totalChunks} chunks from ${files.length} files`);

  // Give graph extraction a moment to finish
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await db.destroy();
}

main().catch((err) => {
  console.error("Ingest failed:", err);
  process.exit(1);
});
