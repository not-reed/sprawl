import type { Kysely } from "kysely";
import { nanoid } from "nanoid";
import type { Database } from "../../db/schema.js";
import { extractInstructions, resolveDependencyIds } from "../../extensions/instructions.js";
import { detectConflicts } from "../../skills/discovery.js";

export interface SkillContext {
  db: Kysely<Database>;
  apiKey?: string;
  embeddingModel?: string;
}

export interface SkillArgs {
  action: string;
  name?: string;
  description?: string;
  body?: string;
  success?: boolean;
  notes?: string;
  conversation_id?: string;
}

export interface HandlerResult {
  output: string;
  details?: unknown;
}

function skillId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

function wrapError(action: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  throw new Error(`Failed to ${action} skill: ${msg}`, { cause: err });
}

async function persistInstructions(
  ctx: SkillContext,
  id: string,
  name: string,
  body: string,
): Promise<{ instructionCount: number }> {
  if (!ctx.apiKey) return { instructionCount: 0 };

  const extracted = await extractInstructions(ctx.apiKey, name, body, ctx.embeddingModel);
  const instructionIds = extracted.instructions.map(() => nanoid(12));

  for (let i = 0; i < extracted.instructions.length; i++) {
    await ctx.db
      .insertInto("skill_instructions")
      .values({
        id: instructionIds[i]!,
        skill_id: id,
        instruction: extracted.instructions[i]!,
        position: i,
      })
      .execute();
  }

  const depRows = resolveDependencyIds(extracted.dependencies, instructionIds);
  for (const dep of depRows) {
    await ctx.db
      .insertInto("skill_instruction_deps")
      .values({ from_id: dep.fromId, to_id: dep.toId, relation: dep.relation })
      .execute();
  }

  return { instructionCount: extracted.instructions.length };
}

async function clearInstructions(ctx: SkillContext, id: string): Promise<void> {
  const oldRows = await ctx.db
    .selectFrom("skill_instructions")
    .select("id")
    .where("skill_id", "=", id)
    .execute();

  const instrIds = oldRows.map((r) => r.id);
  if (instrIds.length > 0) {
    await ctx.db.deleteFrom("skill_instruction_deps").where("from_id", "in", instrIds).execute();
    await ctx.db.deleteFrom("skill_instruction_deps").where("to_id", "in", instrIds).execute();
  }
  await ctx.db.deleteFrom("skill_instructions").where("skill_id", "=", id).execute();
}

export async function handleCreate(ctx: SkillContext, args: SkillArgs): Promise<HandlerResult> {
  if (!args.name || !args.description || !args.body) {
    return {
      output: 'The "create" action requires "name", "description", and "body" parameters.',
      details: { error: "missing_params" },
    };
  }

  const id = skillId(args.name);

  const existingByName = await ctx.db
    .selectFrom("skills")
    .where("name", "=", args.name)
    .select(["id"])
    .executeTakeFirst();

  if (existingByName) {
    return { output: `Skill "${args.name}" already exists. Use action "update" to modify it.` };
  }

  const existingById = await ctx.db
    .selectFrom("skills")
    .where("id", "=", id)
    .select(["name"])
    .executeTakeFirst();

  if (existingById) {
    return {
      output: `Skill ID collision: "${args.name}" normalizes to the same ID as "${existingById.name}". Choose a different name.`,
      details: { error: "id_collision", collidesWith: existingById.name },
    };
  }

  try {
    await ctx.db
      .insertInto("skills")
      .values({
        id,
        name: args.name,
        description: args.description,
        body: args.body,
        version: 1,
        status: "active",
        use_count: 0,
      })
      .execute();

    if (ctx.apiKey) {
      const { instructionCount } = await persistInstructions(ctx, id, args.name, args.body);
      return {
        output: `Created skill "${args.name}" with ${instructionCount} instructions extracted.`,
        details: { skillId: id, instructionCount },
      };
    }

    return {
      output: `Created skill "${args.name}". No API key available for instruction extraction — use shell to reload.`,
      details: { skillId: id },
    };
  } catch (err) {
    wrapError("create", err);
  }
}

export async function handleUpdate(ctx: SkillContext, args: SkillArgs): Promise<HandlerResult> {
  if (!args.name) {
    return {
      output: 'The "update" action requires a "name" parameter.',
      details: { error: "missing_params" },
    };
  }

  const id = skillId(args.name);

  const existing = await ctx.db
    .selectFrom("skills")
    .where("id", "=", id)
    .select(["id", "version", "body"])
    .executeTakeFirst();

  if (!existing) {
    return { output: `Skill "${args.name}" not found.` };
  }

  const newVersion = existing.version + 1;
  const bodyChanged = args.body !== undefined;

  const updateData: Record<string, unknown> = {
    version: newVersion,
    updated_at: new Date().toISOString(),
  };
  if (bodyChanged) {
    updateData.body = args.body;
    updateData.parent_id = existing.id;
  }
  if (args.description !== undefined) {
    updateData.description = args.description;
  }

  try {
    await ctx.db.updateTable("skills").set(updateData).where("id", "=", id).execute();

    if (bodyChanged && ctx.apiKey) {
      await clearInstructions(ctx, id);
      const { instructionCount } = await persistInstructions(ctx, id, args.name, args.body!);
      return {
        output: `Updated skill "${args.name}" to v${newVersion} with ${instructionCount} instructions re-extracted.`,
        details: { skillId: id, newVersion, instructionCount },
      };
    }

    const suffix = bodyChanged && !ctx.apiKey ? ". No API key for instruction extraction." : ".";
    return {
      output: `Updated skill "${args.name}" to v${newVersion}${suffix}`,
      details: { skillId: id, newVersion },
    };
  } catch (err) {
    wrapError("update", err);
  }
}

export async function handleList(ctx: SkillContext): Promise<HandlerResult> {
  try {
    const skills = await ctx.db
      .selectFrom("skills")
      .where("status", "=", "active")
      .select(["id", "name", "description", "version", "use_count", "created_at"])
      .execute();

    if (skills.length === 0) return { output: "No active skills." };

    let output = "Active skills:\n";
    for (const skill of skills) {
      output += `- ${skill.name} (v${skill.version}, ${skill.use_count} uses)\n  ${skill.description}\n`;
    }
    return { output, details: { count: skills.length, skills } };
  } catch (err) {
    wrapError("list", err);
  }
}

export async function handleDelete(ctx: SkillContext, args: SkillArgs): Promise<HandlerResult> {
  if (!args.name) {
    return {
      output: 'The "delete" action requires a "name" parameter.',
      details: { error: "missing_params" },
    };
  }
  const id = skillId(args.name);
  try {
    await ctx.db.updateTable("skills").set({ status: "deprecated" }).where("id", "=", id).execute();

    return { output: `Deprecated skill "${args.name}".`, details: { skillId: id } };
  } catch (err) {
    wrapError("delete", err);
  }
}

export async function handleInspect(ctx: SkillContext, args: SkillArgs): Promise<HandlerResult> {
  if (!args.name) {
    return {
      output: 'The "inspect" action requires a "name" parameter.',
      details: { error: "missing_params" },
    };
  }
  const id = skillId(args.name);
  try {
    const skill = await ctx.db
      .selectFrom("skills")
      .where("id", "=", id)
      .select(["id", "name", "description", "version", "use_count", "created_at", "updated_at"])
      .executeTakeFirst();

    if (!skill) return { output: `Skill "${args.name}" not found.` };

    const instructions = await ctx.db
      .selectFrom("skill_instructions")
      .where("skill_id", "=", skill.id)
      .select(["id", "instruction", "position"])
      .orderBy("position")
      .execute();

    const executions = await ctx.db
      .selectFrom("skill_executions")
      .where("skill_id", "=", skill.id)
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

    let output = `Skill: ${skill.name}\n`;
    output += `Description: ${skill.description}\n`;
    output += `Version: ${skill.version}\n`;
    output += `Uses: ${skill.use_count}\n`;
    output += `Created: ${skill.created_at}\n`;
    output += `Updated: ${skill.updated_at}\n\n`;

    output += `Instructions (${instructions.length}):\n`;
    for (const instr of instructions) {
      output += `  [${instr.position}] ${instr.instruction}\n`;
    }

    output += `\nRecent executions (${executions.length}):\n`;
    for (const exec of executions) {
      const status = exec.success === 1 ? "✓" : exec.success === 0 ? "✗" : "?";
      const errors = exec.had_tool_errors ? " [TOOL ERROR]" : "";
      output += `  ${status} ${exec.created_at}${errors}\n`;
      if (exec.feedback_notes) output += `    Notes: ${exec.feedback_notes}\n`;
    }

    return { output, details: { skill, instructions, executions } };
  } catch (err) {
    wrapError("inspect", err);
  }
}

export async function handleFeedback(ctx: SkillContext, args: SkillArgs): Promise<HandlerResult> {
  if (!args.name || args.success === undefined) {
    return {
      output: 'The "feedback" action requires "name" and "success" parameters.',
      details: { error: "missing_params" },
    };
  }
  const id = skillId(args.name);
  try {
    const skill = await ctx.db
      .selectFrom("skills")
      .where("id", "=", id)
      .select(["id"])
      .executeTakeFirst();

    if (!skill) return { output: `Skill "${args.name}" not found.` };

    const executionId = nanoid(12);
    await ctx.db
      .insertInto("skill_executions")
      .values({
        id: executionId,
        skill_id: skill.id,
        conversation_id: args.conversation_id || "unknown",
        success: args.success ? 1 : 0,
        feedback_notes: args.notes || null,
        had_tool_errors: 0,
      })
      .execute();

    const verdict = args.success ? "success" : "failure";
    const noteSuffix = args.notes ? ` — "${args.notes}"` : "";
    return {
      output: `Recorded feedback for "${args.name}": ${verdict}${noteSuffix}`,
      details: { executionId },
    };
  } catch (err) {
    wrapError("feedback", err);
  }
}

export async function handleConflicts(ctx: SkillContext): Promise<HandlerResult> {
  if (!ctx.apiKey) {
    return {
      output: 'The "conflicts" action requires an API key for embedding similarity.',
      details: { error: "no_api_key" },
    };
  }
  try {
    const conflicts = await detectConflicts(ctx.db, ctx.apiKey, ctx.embeddingModel);
    if (conflicts.length === 0) return { output: "No conflicting instructions detected." };

    let output = `Found ${conflicts.length} potential conflict(s):\n\n`;
    for (const conflict of conflicts) {
      output += `**${conflict.conflictType} conflict** (${(conflict.similarity * 100).toFixed(0)}% match)\n`;
      output += `Skill A: ${conflict.instructionA.skillId}\n`;
      output += `  "${conflict.instructionA.text}"\n`;
      output += `Skill B: ${conflict.instructionB.skillId}\n`;
      output += `  "${conflict.instructionB.text}"\n\n`;
    }

    return { output, details: { conflictCount: conflicts.length, conflicts } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to detect conflicts: ${msg}`, { cause: err });
  }
}
