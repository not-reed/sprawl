import { cpSync, rmSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const CONTENT = resolve(import.meta.dirname, "../src/content/docs");

interface SyncMapping {
  source: string;
  target: string;
}

const mappings: SyncMapping[] = [
  { source: "apps/construct/docs", target: "construct" },
  { source: "apps/cortex/docs", target: "cortex" },
  { source: "apps/synapse/docs", target: "synapse" },
  { source: "apps/deck/docs", target: "deck" },
  { source: "apps/loom/docs", target: "loom" },
  { source: "apps/optic/docs", target: "optic" },
  { source: "packages/cairn/docs", target: "cairn" },
  { source: "packages/db/docs", target: "db" },
];

for (const { source, target } of mappings) {
  const srcDir = join(ROOT, source);
  const destDir = join(CONTENT, target);

  if (!existsSync(srcDir)) {
    console.log(`  skip ${source} (not found)`);
    continue;
  }

  // Clear target dir (idempotent)
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true });
  }
  mkdirSync(destDir, { recursive: true });

  // Copy all .md files
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    cpSync(join(srcDir, file), join(destDir, file));
  }
  console.log(`  sync ${source} -> ${target}/ (${files.length} files)`);
}

console.log("Docs synced.");
