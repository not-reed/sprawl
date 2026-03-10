import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { extractEntities } from "@repo/cairn";
import type { WorkerModelConfig } from "@repo/cairn";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUTPUT = resolve(import.meta.dirname, "../src/data/graph");

const ENTITY_TYPES = ["app", "package", "concept", "pattern", "technology", "person", "entity"];

interface DocFile {
  path: string;
  slug: string;
  content: string;
}

interface NodeEntry {
  id: string;
  name: string;
  display_name: string;
  node_type: string;
  description: string | null;
  appearsIn: string[];
}

interface EdgeEntry {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  weight: number;
}

interface PageGraph {
  nodeIds: string[];
  edgeIds: string[];
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("---", 3);
  if (end === -1) return content;
  return content.slice(end + 3).trim();
}

function slugify(filePath: string): string {
  // Convert file path to URL slug
  // e.g., apps/construct/docs/agent.md -> construct/agent
  const rel = relative(ROOT, filePath);
  return rel
    .replace(/^apps\//, "")
    .replace(/^packages\//, "")
    .replace(/^docs\//, "")
    .replace(/\/docs\//, "/")
    .replace(/\/index\.md$/, "")
    .replace(/\.md$/, "");
}

function canonicalName(name: string): string {
  return name.toLowerCase().trim();
}

function makeNodeId(name: string, type: string): string {
  return `${canonicalName(name)}::${type}`;
}

function makeEdgeId(sourceId: string, targetId: string, relation: string): string {
  return `${sourceId}|${targetId}|${relation.toLowerCase().trim()}`;
}

function collectDocFiles(): DocFile[] {
  const mappings = [
    { dir: "apps/construct/docs", prefix: "construct" },
    { dir: "apps/cortex/docs", prefix: "cortex" },
    { dir: "apps/synapse/docs", prefix: "synapse" },
    { dir: "apps/deck/docs", prefix: "deck" },
    { dir: "apps/loom/docs", prefix: "loom" },
    { dir: "apps/optic/docs", prefix: "optic" },
    { dir: "packages/cairn/docs", prefix: "cairn" },
    { dir: "packages/db/docs", prefix: "db" },
    { dir: "docs/guides", prefix: "guides" },
  ];

  const files: DocFile[] = [];

  for (const { dir } of mappings) {
    const fullDir = join(ROOT, dir);
    if (!existsSync(fullDir)) continue;
    for (const f of readdirSync(fullDir)) {
      if (!f.endsWith(".md")) continue;
      const filePath = join(fullDir, f);
      const raw = readFileSync(filePath, "utf-8");
      const content = stripFrontmatter(raw);
      files.push({
        path: filePath,
        slug: slugify(filePath),
        content,
      });
    }
  }

  // Also include cross-cutting docs
  const archOverview = join(ROOT, "apps/docs/src/content/docs/architecture/overview.md");
  if (existsSync(archOverview)) {
    const raw = readFileSync(archOverview, "utf-8");
    files.push({
      path: archOverview,
      slug: "architecture/overview",
      content: stripFrontmatter(raw),
    });
  }

  return files;
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is required");
    process.exit(1);
  }

  const model =
    process.env.MEMORY_WORKER_MODEL ??
    process.env.OPENROUTER_MODEL ??
    "google/gemini-3.1-flash-lite-preview";

  const config: WorkerModelConfig = {
    apiKey,
    model,
    extraBody: { reasoning: { max_tokens: 1 } },
  };

  const docs = collectDocFiles();
  console.log(`Found ${docs.length} docs to process`);

  const nodes = new Map<string, NodeEntry>();
  const edges = new Map<string, EdgeEntry>();
  const pageGraphs: Record<string, PageGraph> = {};
  let totalTokens = { input: 0, output: 0 };

  for (const doc of docs) {
    console.log(`  extracting: ${doc.slug}`);

    const result = await extractEntities(config, doc.content, undefined, ENTITY_TYPES);

    if (result.usage) {
      totalTokens.input += result.usage.input_tokens;
      totalTokens.output += result.usage.output_tokens;
    }

    const pageNodeIds: string[] = [];
    const pageEdgeIds: string[] = [];

    // Process entities
    for (const entity of result.entities) {
      const id = makeNodeId(entity.name, entity.type);
      const existing = nodes.get(id);
      if (existing) {
        // Merge: keep first description, accumulate appearances
        if (!existing.appearsIn.includes(doc.slug)) {
          existing.appearsIn.push(doc.slug);
        }
        if (!existing.description && entity.description) {
          existing.description = entity.description;
        }
      } else {
        nodes.set(id, {
          id,
          name: canonicalName(entity.name),
          display_name: entity.name,
          node_type: entity.type,
          description: entity.description ?? null,
          appearsIn: [doc.slug],
        });
      }
      if (!pageNodeIds.includes(id)) pageNodeIds.push(id);
    }

    // Process relationships
    for (const rel of result.relationships) {
      // Find source and target nodes
      const sourceEntity = result.entities.find(
        (e) => canonicalName(e.name) === canonicalName(rel.from),
      );
      const targetEntity = result.entities.find(
        (e) => canonicalName(e.name) === canonicalName(rel.to),
      );

      const sourceType = sourceEntity?.type ?? "entity";
      const targetType = targetEntity?.type ?? "entity";
      const sourceId = makeNodeId(rel.from, sourceType);
      const targetId = makeNodeId(rel.to, targetType);

      // Ensure both nodes exist
      if (!nodes.has(sourceId)) {
        nodes.set(sourceId, {
          id: sourceId,
          name: canonicalName(rel.from),
          display_name: rel.from,
          node_type: sourceType,
          description: null,
          appearsIn: [doc.slug],
        });
      }
      if (!nodes.has(targetId)) {
        nodes.set(targetId, {
          id: targetId,
          name: canonicalName(rel.to),
          display_name: rel.to,
          node_type: targetType,
          description: null,
          appearsIn: [doc.slug],
        });
      }

      const edgeId = makeEdgeId(sourceId, targetId, rel.relation);
      const existingEdge = edges.get(edgeId);
      if (existingEdge) {
        existingEdge.weight++;
      } else {
        edges.set(edgeId, {
          id: edgeId,
          source_id: sourceId,
          target_id: targetId,
          relation: rel.relation.toLowerCase().trim(),
          weight: 1,
        });
      }
      if (!pageEdgeIds.includes(edgeId)) pageEdgeIds.push(edgeId);
      if (!pageNodeIds.includes(sourceId)) pageNodeIds.push(sourceId);
      if (!pageNodeIds.includes(targetId)) pageNodeIds.push(targetId);
    }

    pageGraphs[doc.slug] = { nodeIds: pageNodeIds, edgeIds: pageEdgeIds };
  }

  // Write output
  mkdirSync(OUTPUT, { recursive: true });

  const nodesArray = Array.from(nodes.values()).map(({ appearsIn: _appearsIn, ...rest }) => rest);
  const edgesArray = Array.from(edges.values());

  // Include appearsIn in a separate structure within page-graphs
  const nodeAppearsIn: Record<string, string[]> = {};
  for (const [id, node] of nodes) {
    nodeAppearsIn[id] = node.appearsIn;
  }

  writeFileSync(join(OUTPUT, "nodes.json"), JSON.stringify(nodesArray, null, 2));
  writeFileSync(join(OUTPUT, "edges.json"), JSON.stringify(edgesArray, null, 2));
  writeFileSync(
    join(OUTPUT, "page-graphs.json"),
    JSON.stringify({ pages: pageGraphs, nodeAppearsIn }, null, 2),
  );
  writeFileSync(
    join(OUTPUT, "meta.json"),
    JSON.stringify(
      {
        extractedAt: new Date().toISOString(),
        totalDocs: docs.length,
        totalEntities: nodes.size,
        totalRelationships: edges.size,
        totalTokens,
      },
      null,
      2,
    ),
  );

  console.log(`\nExtraction complete:`);
  console.log(`  Docs:          ${docs.length}`);
  console.log(`  Entities:      ${nodes.size}`);
  console.log(`  Relationships: ${edges.size}`);
  console.log(`  Tokens:        ${totalTokens.input} in / ${totalTokens.output} out`);
  console.log(`  Output:        ${OUTPUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
