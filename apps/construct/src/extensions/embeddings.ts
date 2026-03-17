import { generateEmbedding, cosineSimilarity, SIMILARITY } from "@repo/cairn";
import { agentLog } from "../logger.js";
import type { Skill, SkillInstruction } from "./types.js";
import type { ToolPack } from "../tools/packs.js";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";

/** Serialize embedding vector to Buffer for DB storage. */
function embeddingToBuffer(embedding: number[]): Buffer {
  return Buffer.from(new Float64Array(embedding).buffer);
}

/** Deserialize Buffer back to embedding vector. */
function bufferToEmbedding(buf: Buffer): number[] {
  return Array.from(new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8));
}

/** Skill embedding cache: skill name → embedding vector */
const skillEmbeddings = new Map<string, number[]>();

/** Dynamic pack embedding cache: pack name → embedding vector */
const dynamicPackEmbeddings = new Map<string, number[]>();

/**
 * Load cached embeddings from DB. Pure DB reads, zero API calls.
 * Populates skillEmbeddings, cachedInstructions, instructionEmbeddings, and instructionDeps.
 */
export async function loadCachedEmbeddings(db: Kysely<Database>): Promise<void> {
  // Load skill embeddings
  const skillRows = await db
    .selectFrom("skills")
    .where("status", "=", "active")
    .where("embedding", "is not", null)
    .select(["name", "embedding"])
    .execute();

  for (const row of skillRows) {
    if (row.embedding) {
      skillEmbeddings.set(row.name, bufferToEmbedding(row.embedding));
    }
  }

  // Load all active instructions (with or without embeddings)
  const instrRows = await db
    .selectFrom("skill_instructions as si")
    .innerJoin("skills as s", "s.id", "si.skill_id")
    .where("s.status", "=", "active")
    .select(["si.id", "si.skill_id", "si.instruction", "si.position", "si.embedding"])
    .orderBy("si.skill_id")
    .orderBy("si.position")
    .execute();

  cachedInstructions = instrRows.map((r) => ({
    id: r.id,
    skillId: r.skill_id,
    instruction: r.instruction,
    position: r.position,
  }));

  for (const row of instrRows) {
    if (row.embedding) {
      instructionEmbeddings.set(row.id, bufferToEmbedding(row.embedding));
    }
  }

  // Load instruction dependencies
  await loadInstructionDependencies(db);

  agentLog.info`Loaded ${skillEmbeddings.size} cached skill embeddings, ${instructionEmbeddings.size} cached instruction embeddings`;
}

/**
 * Compute embeddings for skills/instructions that don't have cached embeddings.
 * Persists results to DB. Non-fatal per item.
 */
export async function computeMissingEmbeddings(
  db: Kysely<Database>,
  apiKey: string,
  skills: Skill[],
  embeddingModel?: string,
): Promise<void> {
  // Build both batches, run concurrently
  const skillPromises = skills
    .filter((s) => !skillEmbeddings.has(s.name))
    .map(async (skill) => {
      const text = `${skill.name}: ${skill.description}`;
      const embedding = await generateEmbedding(apiKey, text, embeddingModel);
      skillEmbeddings.set(skill.name, embedding);
      const id = skill.name.toLowerCase().replace(/\s+/g, "-");
      await db
        .updateTable("skills")
        .set({ embedding: embeddingToBuffer(embedding) })
        .where("id", "=", id)
        .execute();
    });

  const instrPromises = cachedInstructions
    .filter((instr) => !instructionEmbeddings.has(instr.id))
    .map(async (instr) => {
      const embedding = await generateEmbedding(apiKey, instr.instruction, embeddingModel);
      instructionEmbeddings.set(instr.id, embedding);
      await db
        .updateTable("skill_instructions")
        .set({ embedding: embeddingToBuffer(embedding) })
        .where("id", "=", instr.id)
        .execute();
    });

  const [skillResults, instrResults] = await Promise.all([
    Promise.allSettled(skillPromises),
    Promise.allSettled(instrPromises),
  ]);

  const all = [...skillResults, ...instrResults];
  const computed = all.filter((r) => r.status === "fulfilled").length;
  const failed = all.filter((r) => r.status === "rejected").length;

  if (computed > 0 || failed > 0) {
    agentLog.info`Computed ${computed} missing embeddings${failed > 0 ? `, ${failed} failed` : ""}`;
  }
}

/** Compute embeddings for dynamic tool packs. Non-fatal on failure. */
export async function initDynamicPackEmbeddings(
  apiKey: string,
  packs: ToolPack[],
  embeddingModel?: string,
): Promise<void> {
  dynamicPackEmbeddings.clear();

  const toEmbed = packs.filter((p) => !p.alwaysLoad);
  if (toEmbed.length === 0) return;

  const results = await Promise.allSettled(
    toEmbed.map(async (pack) => {
      const embedding = await generateEmbedding(apiKey, pack.description, embeddingModel);
      dynamicPackEmbeddings.set(pack.name, embedding);
    }),
  );

  let failed = 0;
  for (const r of results) {
    if (r.status === "rejected") failed++;
  }

  agentLog.info`Dynamic pack embeddings: ${dynamicPackEmbeddings.size}/${toEmbed.length} cached${failed > 0 ? `, ${failed} failed` : ""}`;
}

/**
 * Select skills relevant to the query based on embedding similarity.
 * Returns skills sorted by relevance.
 */
export function selectSkills(
  queryEmbedding: number[] | undefined,
  skills: Skill[],
  threshold = SIMILARITY.SKILL_SELECTION,
  maxSkills = 3,
): Skill[] {
  if (skills.length === 0) return [];

  // No query embedding → return nothing (skills are optional context)
  if (!queryEmbedding) return [];

  const scored = skills
    .map((skill) => {
      const emb = skillEmbeddings.get(skill.name);
      if (!emb) return { skill, score: 0 };
      return { skill, score: cosineSimilarity(queryEmbedding, emb) };
    })
    .filter((s) => s.score >= threshold)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, maxSkills);

  return scored.map((s) => s.skill);
}

/**
 * Select dynamic tool packs relevant to the query.
 * Returns packs that meet the similarity threshold.
 */
export function selectDynamicPacks(
  queryEmbedding: number[] | undefined,
  packs: ToolPack[],
  threshold = SIMILARITY.PACK_SELECTION,
): ToolPack[] {
  // No query embedding → load all dynamic packs (graceful fallback)
  if (!queryEmbedding) return packs;

  return packs.filter((pack) => {
    if (pack.alwaysLoad) return true;

    const emb = dynamicPackEmbeddings.get(pack.name);
    // No embedding → load it (graceful fallback)
    if (!emb) return true;

    return cosineSimilarity(queryEmbedding, emb) >= threshold;
  });
}

/** Instruction embedding cache: instruction ID → embedding vector */
const instructionEmbeddings = new Map<string, number[]>();

/** All skill instructions loaded into memory for fast scoring */
let cachedInstructions: SkillInstruction[] = [];

/** Instruction ID → [dependent instruction IDs] (transitive closure) */
const instructionDeps = new Map<string, string[]>();

/**
 * Load all skill instructions from DB and compute their embeddings.
 * Called by background extraction refresh after new instructions are extracted.
 * Also persists embeddings to DB.
 */
export async function initInstructionEmbeddings(
  db: Kysely<Database>,
  apiKey: string,
  embeddingModel?: string,
): Promise<void> {
  instructionEmbeddings.clear();
  instructionDeps.clear();

  // Load all active instructions
  const rows = await db
    .selectFrom("skill_instructions as si")
    .innerJoin("skills as s", "s.id", "si.skill_id")
    .where("s.status", "=", "active")
    .select(["si.id", "si.skill_id", "si.instruction", "si.position"])
    .orderBy("si.skill_id")
    .orderBy("si.position")
    .execute();

  cachedInstructions = rows.map((r) => ({
    id: r.id,
    skillId: r.skill_id,
    instruction: r.instruction,
    position: r.position,
  }));

  if (cachedInstructions.length === 0) {
    agentLog.info`No skill instructions to embed`;
    return;
  }

  // Compute embeddings for all instructions and persist to DB
  const results = await Promise.allSettled(
    cachedInstructions.map(async (instr) => {
      const emb = await generateEmbedding(apiKey, instr.instruction, embeddingModel);
      instructionEmbeddings.set(instr.id, emb);
      await db
        .updateTable("skill_instructions")
        .set({ embedding: embeddingToBuffer(emb) })
        .where("id", "=", instr.id)
        .execute();
    }),
  );

  let failed = 0;
  for (const r of results) {
    if (r.status === "rejected") failed++;
  }

  agentLog.info`Instruction embeddings: ${instructionEmbeddings.size}/${cachedInstructions.length} cached${failed > 0 ? `, ${failed} failed` : ""}`;

  // Load instruction dependencies
  await loadInstructionDependencies(db);
}

/** Load instruction dependency graph from DB */
async function loadInstructionDependencies(db: Kysely<Database>): Promise<void> {
  const depRows = await db
    .selectFrom("skill_instruction_deps")
    .select(["from_id", "to_id"])
    .execute();

  // Build adjacency list with transitive closure
  const graph = new Map<string, Set<string>>();

  for (const { from_id, to_id } of depRows) {
    if (!graph.has(from_id)) {
      graph.set(from_id, new Set());
    }
    graph.get(from_id)!.add(to_id);
  }

  // Transitive closure (simple iterative approach)
  let changed = true;
  while (changed) {
    changed = false;
    for (const [, tos] of graph) {
      for (const to of Array.from(tos)) {
        const transDeps = graph.get(to);
        if (transDeps) {
          transDeps.forEach((d) => {
            if (!tos.has(d)) {
              tos.add(d);
              changed = true;
            }
          });
        }
      }
    }
  }

  // Convert to instructionDeps
  for (const [from, tos] of graph) {
    instructionDeps.set(from, Array.from(tos));
  }
}

/**
 * Select relevant skill instructions for a query, including transitive dependencies.
 * Returns instructions sorted by skill + position for coherent injection.
 */
export async function selectSkillInstructions(
  queryEmbedding: number[] | undefined,
  threshold = SIMILARITY.SKILL_SELECTION,
  maxInstructions = 10,
): Promise<SkillInstruction[]> {
  if (cachedInstructions.length === 0 || !queryEmbedding) {
    return [];
  }

  // Score all instructions against query
  const scored = cachedInstructions
    .map((instr) => {
      const emb = instructionEmbeddings.get(instr.id);
      if (!emb) return { instr, score: 0 };
      return { instr, score: cosineSimilarity(queryEmbedding, emb) };
    })
    .filter((s) => s.score >= threshold)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, maxInstructions);

  // Collect selected instructions + transitive dependencies
  const selected = new Set<string>();
  const toAdd = new Set(scored.map((s) => s.instr.id));

  // Breadth-first traversal of dependencies
  while (toAdd.size > 0) {
    const id = toAdd.values().next().value as string;
    toAdd.delete(id);

    if (!selected.has(id)) {
      selected.add(id);

      // Add all dependencies
      const deps = instructionDeps.get(id) || [];
      for (const depId of deps) {
        if (!selected.has(depId)) {
          toAdd.add(depId);
        }
      }
    }
  }

  // Return selected instructions, maintaining skill + position order
  const result = cachedInstructions.filter((instr) => selected.has(instr.id));
  return result;
}

/** Clear all instruction caches. Called on reload. */
export function clearInstructionEmbeddings(): void {
  instructionEmbeddings.clear();
  instructionDeps.clear();
  cachedInstructions = [];
}

/** Clear all extension embedding caches. Called on reload. */
export function clearExtensionEmbeddings(): void {
  skillEmbeddings.clear();
  dynamicPackEmbeddings.clear();
  clearInstructionEmbeddings();
}
