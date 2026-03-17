import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { ExtensionRegistry, Skill } from "./types.js";
import type { ToolContext, InternalTool } from "../tools/packs.js";
import type { TSchema } from "@sinclair/typebox";
import { loadIdentityFiles, loadSkills, loadDynamicTools } from "./loader.js";
import { buildSecretsMap } from "./secrets.js";
import {
  initDynamicPackEmbeddings,
  initInstructionEmbeddings,
  loadCachedEmbeddings,
  computeMissingEmbeddings,
  selectSkills as selectSkillsByEmbedding,
  selectDynamicPacks as selectDynamicPacksByEmbedding,
  selectSkillInstructions,
  clearExtensionEmbeddings,
} from "./embeddings.js";
import { extractInstructions, resolveDependencyIds } from "./instructions.js";
import { agentLog } from "../logger.js";
import { ExtensionError } from "../errors.js";
import { nanoid } from "nanoid";

// Singleton registry
let registry: ExtensionRegistry = {
  identity: { soul: null, identity: null, user: null },
  skills: [],
  dynamicPacks: [],
};

let extensionsDir: string = "";
let apiKey: string = "";
let embeddingModel: string | undefined;
let extractionModel: string | undefined;
let dbRef: Kysely<Database> | null = null;
let reloadLock: Promise<ExtensionRegistry> | null = null;

/** Ensure extensions directory and subdirectories exist. */
async function ensureDirs(dir: string): Promise<void> {
  await mkdir(join(dir, "skills"), { recursive: true });
  await mkdir(join(dir, "tools"), { recursive: true });
}

/**
 * Initialize the extensions system. Called once at startup.
 */
export async function initExtensions(
  dir: string,
  key: string,
  db: Kysely<Database>,
  model?: string,
  chatModel?: string,
): Promise<ExtensionRegistry> {
  extensionsDir = dir;
  apiKey = key;
  embeddingModel = model;
  extractionModel = chatModel;
  dbRef = db;

  await ensureDirs(dir);

  return reloadExtensions();
}

/**
 * Reload all extensions from disk. Called on startup and by extension_reload tool.
 * Returns the updated registry. Serialized via lock to prevent concurrent reloads.
 */
export async function reloadExtensions(): Promise<ExtensionRegistry> {
  if (reloadLock) {
    agentLog.info`Reload already in progress, waiting…`;
    return reloadLock;
  }

  reloadLock = doReload();
  try {
    return await reloadLock;
  } finally {
    reloadLock = null;
  }
}

async function doReload(): Promise<ExtensionRegistry> {
  if (!extensionsDir || !dbRef) {
    throw new ExtensionError("Extensions not initialized — call initExtensions() first");
  }

  agentLog.info`Reloading extensions from ${extensionsDir}`;

  // Clear embedding caches
  clearExtensionEmbeddings();

  // Load identity files (SOUL.md, IDENTITY.md, USER.md)
  const identity = await loadIdentityFiles(extensionsDir);

  // Load skills from disk
  const skillsFromDisk = await loadSkills(extensionsDir);

  // Fast sync: upsert skills with fallback instructions (no LLM calls)
  const { skills, needsExtraction } = await syncSkillsFromDisk(dbRef!, skillsFromDisk);
  agentLog.info`Loaded ${skills.length} skill(s)${needsExtraction.length > 0 ? `, ${needsExtraction.length} pending extraction` : ""}`;

  // Build secrets map for dynamic tool context
  const secretsMap = await buildSecretsMap(dbRef!);
  const availableSecrets = new Set(secretsMap.keys());

  // Load dynamic tools
  const dynamicPacks = await loadDynamicTools(
    extensionsDir,
    { secrets: secretsMap },
    availableSecrets,
  );
  agentLog.info`Loaded ${dynamicPacks.length} dynamic pack(s)`;

  // Update registry
  registry = { identity, skills, dynamicPacks };

  // Load cached embeddings from DB (fast, no API calls)
  await loadCachedEmbeddings(dbRef!);

  // Fire-and-forget: compute any missing embeddings + graph sync
  computeMissingEmbeddings(dbRef!, apiKey, skills, embeddingModel).catch((err) => {
    agentLog.warning`Background embedding computation failed: ${err}`;
  });
  initDynamicPackEmbeddings(apiKey, dynamicPacks, embeddingModel).catch((err) => {
    agentLog.warning`Background dynamic pack embedding failed: ${err}`;
  });
  syncAllSkillsToGraph(dbRef!).catch((err) => {
    agentLog.warning`Background graph sync failed: ${err}`;
  });

  // Fire-and-forget: extract proper instructions in background
  if (needsExtraction.length > 0) {
    extractInstructionsInBackground(dbRef!, needsExtraction).catch((err) => {
      agentLog.warning`Background instruction extraction failed: ${err}`;
    });
  }

  return registry;
}

/**
 * Sync all skills and instructions to Cairn graph.
 * Called at startup to build the initial graph structure.
 * Skills get exported from here later for dynamic edges.
 */
async function syncAllSkillsToGraph(db: Kysely<Database>): Promise<void> {
  // Note: This syncs the static structure. Dynamic edges (applied_in, failed_on)
  // are added during execution in agent.ts when we have the memory manager.
  // For now, this is a placeholder that logs the count.
  try {
    const skillCount = await db
      .selectFrom("skills")
      .where("status", "=", "active")
      .select(db.fn.count<number>("id").as("count"))
      .executeTakeFirstOrThrow();

    const instrCount = await db
      .selectFrom("skill_instructions")
      .innerJoin("skills", "skills.id", "skill_instructions.skill_id")
      .where("skills.status", "=", "active")
      .select(db.fn.count<number>("skill_instructions.id").as("count"))
      .executeTakeFirstOrThrow();

    agentLog.debug`Ready for graph sync: ${skillCount.count} skills, ${instrCount.count} instructions (dynamic edges added during execution)`;
  } catch (err) {
    agentLog.warning`Failed to count skills for graph: ${err}`;
  }
}

/**
 * Fast sync: upsert skills to DB with body-as-fallback-instruction for new/changed skills.
 * Returns the list of skill IDs that need background extraction.
 */
async function syncSkillsFromDisk(
  db: Kysely<Database>,
  skillsFromDisk: Skill[],
): Promise<{
  skills: Skill[];
  needsExtraction: Array<{ id: string; skill: Skill; version: number }>;
}> {
  const skills: Skill[] = [];
  const needsExtraction: Array<{ id: string; skill: Skill; version: number }> = [];

  for (const diskSkill of skillsFromDisk) {
    const id = diskSkill.name.toLowerCase().replace(/\s+/g, "-");

    // Check if skill exists and body changed
    const existing = await db
      .selectFrom("skills")
      .where("id", "=", id)
      .select(["id", "body", "version", "parent_id"])
      .executeTakeFirst();

    if (existing && existing.body === diskSkill.body) {
      // No changes — skip
      skills.push(diskSkill);
      continue;
    }

    // Create new skill version
    const parentId = existing?.id || null;
    const newVersion = (existing?.version || 0) + 1;
    const skillId = existing?.id || id;

    // Upsert skill
    await db
      .insertInto("skills")
      .values({
        id: skillId,
        name: diskSkill.name,
        description: diskSkill.description,
        body: diskSkill.body,
        version: newVersion,
        parent_id: parentId,
        status: "active",
        use_count: 0,
        updated_at: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          description: diskSkill.description,
          body: diskSkill.body,
          version: newVersion,
          parent_id: parentId,
          status: "active",
          embedding: null,
          updated_at: new Date().toISOString(),
        }),
      )
      .execute();

    // Delete old instructions and their deps, then insert fallback
    const oldInstrIds = await db
      .selectFrom("skill_instructions")
      .where("skill_id", "=", skillId)
      .select("id")
      .execute();
    if (oldInstrIds.length > 0) {
      const ids = oldInstrIds.map((r) => r.id);
      await db
        .deleteFrom("skill_instruction_deps")
        .where((eb) => eb.or([eb("from_id", "in", ids), eb("to_id", "in", ids)]))
        .execute();
    }
    await db.deleteFrom("skill_instructions").where("skill_id", "=", skillId).execute();
    await db
      .insertInto("skill_instructions")
      .values({
        id: nanoid(12),
        skill_id: skillId,
        instruction: diskSkill.body,
        position: 0,
      })
      .execute();

    agentLog.info`Synced skill "${diskSkill.name}" (v${newVersion}, pending extraction)`;
    skills.push(diskSkill);
    needsExtraction.push({ id: skillId, skill: diskSkill, version: newVersion });
  }

  return { skills, needsExtraction };
}

/**
 * Background extraction: replace fallback instructions with LLM-extracted atomic instructions.
 * Runs after boot — the agent is already responsive with fallback instructions.
 */
async function extractInstructionsInBackground(
  db: Kysely<Database>,
  pending: Array<{ id: string; skill: Skill; version: number }>,
): Promise<void> {
  if (pending.length === 0) return;

  agentLog.info`Background extraction starting for ${pending.length} skill(s)`;

  for (const { id, skill, version } of pending) {
    try {
      const extracted = await extractInstructions(apiKey, skill.name, skill.body, extractionModel);

      // Skip if extraction returned a single instruction matching the body (fallback)
      if (extracted.instructions.length <= 1 && extracted.instructions[0] === skill.body) {
        agentLog.warning`Extraction returned fallback for "${skill.name}", keeping as-is`;
        continue;
      }

      // Replace fallback instruction with extracted ones (delete deps first)
      const oldIds = await db
        .selectFrom("skill_instructions")
        .where("skill_id", "=", id)
        .select("id")
        .execute();
      if (oldIds.length > 0) {
        const ids = oldIds.map((r) => r.id);
        await db
          .deleteFrom("skill_instruction_deps")
          .where((eb) => eb.or([eb("from_id", "in", ids), eb("to_id", "in", ids)]))
          .execute();
      }
      await db.deleteFrom("skill_instructions").where("skill_id", "=", id).execute();

      const instructionIds: string[] = [];
      for (let i = 0; i < extracted.instructions.length; i++) {
        const instrId = nanoid(12);
        instructionIds.push(instrId);

        await db
          .insertInto("skill_instructions")
          .values({
            id: instrId,
            skill_id: id,
            instruction: extracted.instructions[i]!,
            position: i,
          })
          .execute();
      }

      // Insert instruction dependencies
      const deps = resolveDependencyIds(extracted.dependencies, instructionIds);
      for (const dep of deps) {
        await db
          .insertInto("skill_instruction_deps")
          .values({
            from_id: dep.fromId,
            to_id: dep.toId,
            relation: dep.relation,
          })
          .onConflict((oc) => oc.columns(["from_id", "to_id"]).doNothing())
          .execute();
      }

      agentLog.info`Extracted skill "${skill.name}" (v${version}, ${extracted.instructions.length} instructions)`;
    } catch (err) {
      agentLog.warning`Background extraction failed for "${skill.name}": ${err}`;
      // Fallback instruction remains — agent can still use it
    }
  }

  // Re-compute instruction embeddings with the new extractions
  try {
    await initInstructionEmbeddings(db, apiKey, embeddingModel);
    agentLog.info`Background extraction complete — instruction embeddings refreshed`;
  } catch (err) {
    agentLog.warning`Failed to refresh instruction embeddings after extraction: ${err}`;
  }
}

/**
 * Sync skill instructions to Cairn graph.
 * Called from agent.ts after skill instructions are retrieved, with memory manager available.
 * Creates: instruction nodes + dependency edges.
 * Dynamic edges (applied_in, failed_on) are added during execution.
 */
export async function syncSkillInstructionsToGraph(
  instructionIds: string[],
  deps: Array<{ fromId: string; toId: string; relation: string }>,
  memoryManager: any,
): Promise<void> {
  try {
    const { upsertNode, upsertEdge } = memoryManager;

    // Upsert instruction nodes
    for (const instrId of instructionIds) {
      const instr = await dbRef
        ?.selectFrom("skill_instructions")
        .where("id", "=", instrId)
        .select(["instruction", "skill_id"])
        .executeTakeFirst();

      if (instr) {
        // Instruction node
        await upsertNode(instrId, "skill_instruction", instr.instruction, "");

        // Skill node (may already exist)
        const skill = await dbRef
          ?.selectFrom("skills")
          .where("id", "=", instr.skill_id)
          .select(["name", "description"])
          .executeTakeFirst();

        if (skill) {
          await upsertNode(instr.skill_id, "skill", skill.name, skill.description);

          // Edge: skill contains instruction
          await upsertEdge(instr.skill_id, instrId, "contains");
        }
      }
    }

    // Upsert dependency edges between instructions
    for (const dep of deps) {
      await upsertEdge(dep.fromId, dep.toId, "requires");
    }
  } catch (err) {
    agentLog.warning`Failed to sync instructions to graph: ${err}`;
    // Non-fatal — instructions are already in DB
  }
}

/** Get the current extension registry. */
export function getExtensionRegistry(): ExtensionRegistry {
  return registry;
}

/** Select skills relevant to a query using embedding similarity. */
export function selectSkills(queryEmbedding: number[] | undefined): Skill[] {
  return selectSkillsByEmbedding(queryEmbedding, registry.skills);
}

/**
 * Select dynamic tool packs and instantiate tools for a query.
 * Merges dynamic packs that pass the embedding threshold.
 */
export function selectAndCreateDynamicTools(
  queryEmbedding: number[] | undefined,
  ctx: ToolContext,
): InternalTool<TSchema>[] {
  const selected = selectDynamicPacksByEmbedding(queryEmbedding, registry.dynamicPacks);

  if (selected.length > 0) {
    agentLog.info`Selected dynamic packs: ${selected.map((p) => p.name).join(", ")}`;
  }

  const tools: InternalTool<TSchema>[] = [];
  for (const pack of selected) {
    for (const factory of pack.factories) {
      const tool = factory(ctx);
      if (tool) tools.push(tool);
    }
  }
  return tools;
}

/**
 * Select and retrieve relevant skill instructions for a query, including transitive dependencies.
 */
export async function selectAndRetrieveSkillInstructions(
  queryEmbedding: number[] | undefined,
): Promise<string[]> {
  const instructions = await selectSkillInstructions(queryEmbedding);

  if (instructions.length > 0) {
    agentLog.info`Selected ${instructions.length} skill instruction(s)`;
  }

  // Group by skill for readability
  const bySkill = new Map<string, typeof instructions>();
  for (const instr of instructions) {
    if (!bySkill.has(instr.skillId)) {
      bySkill.set(instr.skillId, []);
    }
    bySkill.get(instr.skillId)!.push(instr);
  }

  // Format: "[skill_name]\n- instruction 1\n- instruction 2"
  const formatted: string[] = [];
  for (const [skillId, instrs] of bySkill) {
    const skill = registry.skills.find(
      (s) => s.name.toLowerCase().replace(/\s+/g, "-") === skillId,
    );
    if (skill) {
      formatted.push(`[${skill.name}]`);
      for (const instr of instrs) {
        formatted.push(`- ${instr.instruction}`);
      }
    }
  }

  return formatted;
}
