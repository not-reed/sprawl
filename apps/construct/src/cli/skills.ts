import { defineCommand } from "citty";
import { z } from "zod";
import { createDb } from "@repo/db";
import { generateEmbedding } from "@repo/cairn";
import type { Database } from "../db/schema.js";
import { runMigrations } from "../db/migrate.js";
import { extractInstructions, resolveDependencyIds } from "../extensions/instructions.js";
import { initInstructionEmbeddings, selectSkillInstructions } from "../extensions/embeddings.js";
import { nanoid } from "nanoid";

// Minimal env for CLI (no TELEGRAM_BOT_TOKEN needed)
const skillsEnv = z
  .object({
    DATABASE_URL: z.string().default("./data/construct.db"),
    OPENROUTER_API_KEY: z.string().optional(),
    EMBEDDING_MODEL: z.string().default("qwen/qwen3-embedding-8b"),
  })
  .parse(process.env);

// --- Helper: format table ---

function formatTable(headers: string[], rows: (string | number)[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)),
  );

  const divider = headers.map((_, i) => "─".repeat(widths[i])).join("─┼─");
  const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join(" │ ");
  const dataRows = rows
    .map((row) =>
      row.map((cell, i) => String(cell === undefined ? "" : cell).padEnd(widths[i])).join(" │ "),
    )
    .join("\n");

  return `${headerRow}\n${divider}\n${dataRows}`;
}

// --- Subcommands ---

const listCommand = defineCommand({
  meta: { name: "list", description: "List all active skills" },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    await runMigrations(skillsEnv.DATABASE_URL);
    const { db } = createDb<Database>(skillsEnv.DATABASE_URL);

    try {
      const skills = await db
        .selectFrom("skills")
        .where("status", "=", "active")
        .leftJoin("skill_instructions", "skills.id", "skill_instructions.skill_id")
        .groupBy("skills.id")
        .select([
          "skills.id",
          "skills.name",
          "skills.description",
          "skills.version",
          "skills.use_count",
          "skills.created_at",
          db.fn.count<number>("skill_instructions.id").as("instruction_count"),
        ])
        .execute();

      if (skills.length === 0) {
        console.log("No active skills.");
        return;
      }

      if (args.json) {
        console.log(JSON.stringify(skills, null, 2));
        return;
      }

      const rows = skills.map((s) => [
        s.name,
        `v${s.version}`,
        s.use_count,
        s.instruction_count,
        s.description?.substring(0, 50) || "(no description)",
      ]);

      console.log(formatTable(["Name", "Version", "Uses", "Instructions", "Description"], rows));
    } finally {
      await db.destroy();
    }
  },
});

const inspectCommand = defineCommand({
  meta: { name: "inspect", description: "Inspect a skill's details" },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "Skill name",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    if (!args.name) {
      console.error("Skill name required");
      process.exit(1);
    }

    await runMigrations(skillsEnv.DATABASE_URL);
    const { db } = createDb<Database>(skillsEnv.DATABASE_URL);

    try {
      const skillId = args.name.toLowerCase().replace(/\s+/g, "-");

      const skill = await db
        .selectFrom("skills")
        .where("id", "=", skillId)
        .select(["id", "name", "description", "version", "use_count", "created_at", "updated_at"])
        .executeTakeFirst();

      if (!skill) {
        console.error(`Skill "${args.name}" not found`);
        process.exit(1);
      }

      const instructions = await db
        .selectFrom("skill_instructions")
        .where("skill_id", "=", skillId)
        .select(["id", "instruction", "position"])
        .orderBy("position")
        .execute();

      const executions = await db
        .selectFrom("skill_executions")
        .where("skill_id", "=", skillId)
        .select([
          "id",
          "conversation_id",
          "had_tool_errors",
          "success",
          "feedback_notes",
          "created_at",
        ])
        .orderBy("created_at", "desc")
        .limit(5)
        .execute();

      if (args.json) {
        console.log(JSON.stringify({ skill, instructions, executions }, null, 2));
        return;
      }

      console.log(`Skill: ${skill.name}`);
      console.log(`Description: ${skill.description}`);
      console.log(`Version: ${skill.version}`);
      console.log(`Uses: ${skill.use_count}`);
      console.log(`Created: ${skill.created_at}`);
      console.log(`Updated: ${skill.updated_at}`);

      console.log(`\nInstructions (${instructions.length}):`);
      for (const instr of instructions) {
        const preview = instr.instruction.substring(0, 60);
        console.log(`  [${instr.position}] ${preview}${instr.instruction.length > 60 ? "…" : ""}`);
      }

      console.log(`\nRecent executions (${executions.length}):`);
      for (const exec of executions) {
        const status = exec.success === 1 ? "✓" : exec.success === 0 ? "✗" : "?";
        const errors = exec.had_tool_errors ? " [TOOL ERROR]" : "";
        console.log(`  ${status} ${exec.created_at}${errors}`);
        if (exec.feedback_notes) {
          console.log(`    Notes: ${exec.feedback_notes}`);
        }
      }
    } finally {
      await db.destroy();
    }
  },
});

const extractCommand = defineCommand({
  meta: { name: "extract", description: "Extract instructions from a skill" },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "Skill name",
    },
  },
  async run({ args }) {
    if (!args.name) {
      console.error("Skill name required");
      process.exit(1);
    }

    if (!skillsEnv.OPENROUTER_API_KEY) {
      console.error("OPENROUTER_API_KEY environment variable is required");
      process.exit(1);
    }

    await runMigrations(skillsEnv.DATABASE_URL);
    const { db } = createDb<Database>(skillsEnv.DATABASE_URL);

    try {
      const skillId = args.name.toLowerCase().replace(/\s+/g, "-");

      const skill = await db
        .selectFrom("skills")
        .where("id", "=", skillId)
        .select(["id", "name", "body"])
        .executeTakeFirst();

      if (!skill) {
        console.error(`Skill "${args.name}" not found`);
        process.exit(1);
      }

      console.log(`Extracting instructions from "${skill.name}"...`);

      const extracted = await extractInstructions(
        skillsEnv.OPENROUTER_API_KEY,
        skill.name,
        skill.body,
        skillsEnv.EMBEDDING_MODEL,
      );

      console.log(`Found ${extracted.instructions.length} instructions`);

      // Delete old instructions
      await db.deleteFrom("skill_instructions").where("skill_id", "=", skillId).execute();

      const instructionIds = extracted.instructions.map(() => nanoid(12));

      // Insert new instruction rows
      for (let i = 0; i < extracted.instructions.length; i++) {
        await db
          .insertInto("skill_instructions")
          .values({
            id: instructionIds[i]!,
            skill_id: skillId,
            instruction: extracted.instructions[i]!,
            position: i,
          })
          .execute();
      }

      // Insert dependency rows
      const depRows = resolveDependencyIds(extracted.dependencies, instructionIds);
      for (const dep of depRows) {
        await db
          .insertInto("skill_instruction_deps")
          .values({
            from_id: dep.fromId,
            to_id: dep.toId,
            relation: dep.relation,
          })
          .execute();
      }

      console.log(
        `✓ Extracted and stored ${extracted.instructions.length} instructions with ${depRows.length} dependencies`,
      );
    } finally {
      await db.destroy();
    }
  },
});

const testCommand = defineCommand({
  meta: { name: "test", description: "Test instruction retrieval for a context" },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "Skill name",
    },
    context: {
      type: "string",
      required: true,
      description: "Context query string",
    },
  },
  async run({ args }) {
    if (!args.name) {
      console.error("Skill name required");
      process.exit(1);
    }

    if (!args.context) {
      console.error("--context is required");
      process.exit(1);
    }

    if (!skillsEnv.OPENROUTER_API_KEY) {
      console.error("OPENROUTER_API_KEY environment variable is required");
      process.exit(1);
    }

    await runMigrations(skillsEnv.DATABASE_URL);
    const { db } = createDb<Database>(skillsEnv.DATABASE_URL);

    try {
      console.log(`Testing instruction retrieval for skill "${args.name}"...`);

      // Generate embedding for context
      const contextEmbedding = await generateEmbedding(
        skillsEnv.OPENROUTER_API_KEY,
        args.context,
        skillsEnv.EMBEDDING_MODEL,
      );

      // Load instruction embeddings
      await initInstructionEmbeddings(db, skillsEnv.OPENROUTER_API_KEY, skillsEnv.EMBEDDING_MODEL);

      // Select relevant instructions
      const selected = await selectSkillInstructions(contextEmbedding);

      if (selected.length === 0) {
        console.log("No relevant instructions found for context");
        return;
      }

      // Group by skill
      const bySkill = new Map<string, typeof selected>();
      for (const instr of selected) {
        if (!bySkill.has(instr.skillId)) {
          bySkill.set(instr.skillId, []);
        }
        bySkill.get(instr.skillId)!.push(instr);
      }

      console.log(`\nSelected ${selected.length} instructions from ${bySkill.size} skill(s):\n`);

      for (const [skillId, instrs] of bySkill) {
        const skill = await db
          .selectFrom("skills")
          .where("id", "=", skillId)
          .select(["name"])
          .executeTakeFirst();

        console.log(`  ${skill?.name || skillId}`);
        for (const instr of instrs) {
          console.log(`    [${instr.position}] ${instr.instruction}`);
        }
        console.log();
      }
    } finally {
      await db.destroy();
    }
  },
});

// --- Main command ---

export const skillsCommand = defineCommand({
  meta: {
    name: "skills",
    description: "Manage skills (living instructions)",
  },
  subCommands: {
    list: listCommand,
    inspect: inspectCommand,
    extract: extractCommand,
    test: testCommand,
  },
});
