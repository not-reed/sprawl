import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { InternalTool } from "../packs.js";
import { nanoid } from "nanoid";
import { extractInstructions, resolveDependencyIds } from "../../extensions/instructions.js";

// --- Tool: skill_create ---

const SkillCreateParams = Type.Object({
  name: Type.String({ description: "Skill name (e.g., 'Jellyfin API')" }),
  description: Type.String({ description: "Brief skill description" }),
  body: Type.String({ description: "Skill body (markdown format with instructions)" }),
});

export function createSkillCreateTool(
  db: Kysely<Database>,
  apiKey?: string,
  embeddingModel?: string,
): InternalTool<TSchema> {
  return {
    name: "skill_create",
    description:
      "Create a new skill. The skill body is automatically parsed into atomic instructions.",
    parameters: SkillCreateParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typedArgs = args as Static<typeof SkillCreateParams>;
      const id = typedArgs.name.toLowerCase().replace(/\s+/g, "-");

      // Check if skill already exists
      const existing = await db
        .selectFrom("skills")
        .where("name", "=", typedArgs.name)
        .select(["id"])
        .executeTakeFirst();

      if (existing) {
        return {
          output: `Skill "${typedArgs.name}" already exists. Use skill_update to modify it.`,
        };
      }

      try {
        await db
          .insertInto("skills")
          .values({
            id,
            name: typedArgs.name,
            description: typedArgs.description,
            body: typedArgs.body,
            version: 1,
            status: "active",
            use_count: 0,
          })
          .execute();

        // Extract instructions if apiKey is available
        if (apiKey) {
          const extracted = await extractInstructions(
            apiKey,
            typedArgs.name,
            typedArgs.body,
            embeddingModel,
          );

          const instructionIds = extracted.instructions.map(() => nanoid(12));

          // Insert instruction rows
          for (let i = 0; i < extracted.instructions.length; i++) {
            await db
              .insertInto("skill_instructions")
              .values({
                id: instructionIds[i]!,
                skill_id: id,
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

          return {
            output: `Created skill "${typedArgs.name}" with ${extracted.instructions.length} instructions extracted.`,
            details: { skillId: id, instructionCount: extracted.instructions.length },
          };
        }

        return {
          output: `Created skill "${typedArgs.name}". Run extension_reload to extract instructions.`,
          details: { skillId: id },
        };
      } catch (err) {
        throw new Error(
          `Failed to create skill: ${err instanceof Error ? err.message : String(err)}`,
          {
            cause: err,
          },
        );
      }
    },
  };
}

// --- Tool: skill_update ---

const SkillUpdateParams = Type.Object({
  name: Type.String({ description: "Skill name to update" }),
  body: Type.Optional(Type.String({ description: "New skill body" })),
  description: Type.Optional(Type.String({ description: "New description" })),
});

export function createSkillUpdateTool(
  db: Kysely<Database>,
  apiKey?: string,
  embeddingModel?: string,
): InternalTool<TSchema> {
  return {
    name: "skill_update",
    description:
      "Update a skill body or description. Changes to body will trigger instruction re-extraction.",
    parameters: SkillUpdateParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typedArgs = args as Static<typeof SkillUpdateParams>;
      const id = typedArgs.name.toLowerCase().replace(/\s+/g, "-");

      const existing = await db
        .selectFrom("skills")
        .where("id", "=", id)
        .select(["id", "version", "body"])
        .executeTakeFirst();

      if (!existing) {
        return { output: `Skill "${typedArgs.name}" not found.` };
      }

      const newVersion = existing.version + 1;
      const updateData: Record<string, unknown> = {
        version: newVersion,
        updated_at: new Date().toISOString(),
      };

      const bodyChanged = typedArgs.body !== undefined;

      if (bodyChanged) {
        updateData.body = typedArgs.body;
        updateData.parent_id = existing.id;
      }

      if (typedArgs.description !== undefined) {
        updateData.description = typedArgs.description;
      }

      try {
        await db.updateTable("skills").set(updateData).where("id", "=", id).execute();

        // Re-extract instructions if body changed and apiKey is available
        if (bodyChanged && apiKey) {
          const extracted = await extractInstructions(
            apiKey,
            typedArgs.name,
            typedArgs.body!,
            embeddingModel,
          );

          // Delete old instruction dependencies first (foreign key constraint)
          const oldInstructionIds = await db
            .selectFrom("skill_instructions")
            .select("id")
            .where("skill_id", "=", id)
            .execute();

          const instrIds = oldInstructionIds.map((r) => r.id);
          if (instrIds.length > 0) {
            // Delete dependencies where this instruction is the source
            await db
              .deleteFrom("skill_instruction_deps")
              .where("from_id", "in", instrIds)
              .execute();

            // Delete dependencies where this instruction is the target
            await db.deleteFrom("skill_instruction_deps").where("to_id", "in", instrIds).execute();
          }

          // Then delete old instructions
          await db.deleteFrom("skill_instructions").where("skill_id", "=", id).execute();

          const instructionIds = extracted.instructions.map(() => nanoid(12));

          // Insert new instruction rows
          for (let i = 0; i < extracted.instructions.length; i++) {
            await db
              .insertInto("skill_instructions")
              .values({
                id: instructionIds[i]!,
                skill_id: id,
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

          return {
            output: `Updated skill "${typedArgs.name}" to v${newVersion} with ${extracted.instructions.length} instructions re-extracted.`,
            details: { skillId: id, newVersion, instructionCount: extracted.instructions.length },
          };
        }

        return {
          output: `Updated skill "${typedArgs.name}" to v${newVersion}${bodyChanged && !apiKey ? ". Run extension_reload to re-extract instructions." : "."}`,
          details: { skillId: id, newVersion },
        };
      } catch (err) {
        throw new Error(
          `Failed to update skill: ${err instanceof Error ? err.message : String(err)}`,
          {
            cause: err,
          },
        );
      }
    },
  };
}

// --- Tool: skill_list ---

const SkillListParams = Type.Object({});

export function createSkillListTool(db: Kysely<Database>): InternalTool<TSchema> {
  return {
    name: "skill_list",
    description: "List all active skills with metadata.",
    parameters: SkillListParams,
    execute: async () => {
      try {
        const skills = await db
          .selectFrom("skills")
          .where("status", "=", "active")
          .select(["id", "name", "description", "version", "use_count", "created_at"])
          .execute();

        if (skills.length === 0) {
          return { output: "No active skills." };
        }

        let output = "Active skills:\n";
        for (const skill of skills) {
          output += `- ${skill.name} (v${skill.version}, ${skill.use_count} uses)\n  ${skill.description}\n`;
        }

        return { output, details: { count: skills.length, skills } };
      } catch (err) {
        throw new Error(
          `Failed to list skills: ${err instanceof Error ? err.message : String(err)}`,
          {
            cause: err,
          },
        );
      }
    },
  };
}

// --- Tool: skill_delete ---

const SkillDeleteParams = Type.Object({
  name: Type.String({ description: "Skill name to delete" }),
});

export function createSkillDeleteTool(db: Kysely<Database>): InternalTool<TSchema> {
  return {
    name: "skill_delete",
    description: "Delete (deprecate) a skill. Instructions are preserved for rollback.",
    parameters: SkillDeleteParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typedArgs = args as Static<typeof SkillDeleteParams>;
      const id = typedArgs.name.toLowerCase().replace(/\s+/g, "-");

      try {
        await db.updateTable("skills").set({ status: "deprecated" }).where("id", "=", id).execute();

        return {
          output: `Deprecated skill "${typedArgs.name}".`,
          details: { skillId: id },
        };
      } catch (err) {
        throw new Error(
          `Failed to delete skill: ${err instanceof Error ? err.message : String(err)}`,
          {
            cause: err,
          },
        );
      }
    },
  };
}

// --- Tool: skill_inspect ---

const SkillInspectParams = Type.Object({
  name: Type.String({ description: "Skill name to inspect" }),
});

export function createSkillInspectTool(db: Kysely<Database>): InternalTool<TSchema> {
  return {
    name: "skill_inspect",
    description: "Inspect a skill's instructions, dependencies, and execution history.",
    parameters: SkillInspectParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typedArgs = args as Static<typeof SkillInspectParams>;
      const id = typedArgs.name.toLowerCase().replace(/\s+/g, "-");

      try {
        const skill = await db
          .selectFrom("skills")
          .where("id", "=", id)
          .select(["id", "name", "description", "version", "use_count", "created_at", "updated_at"])
          .executeTakeFirst();

        if (!skill) {
          return { output: `Skill "${typedArgs.name}" not found.` };
        }

        // Get instructions
        const instructions = await db
          .selectFrom("skill_instructions")
          .where("skill_id", "=", skill.id)
          .select(["id", "instruction", "position"])
          .orderBy("position")
          .execute();

        // Get recent executions
        const executions = await db
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
          if (exec.feedback_notes) {
            output += `    Notes: ${exec.feedback_notes}\n`;
          }
        }

        return {
          output,
          details: {
            skill,
            instructions,
            executions,
          },
        };
      } catch (err) {
        throw new Error(
          `Failed to inspect skill: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}

// --- Tool: skill_feedback ---

const SkillFeedbackParams = Type.Object({
  name: Type.String({ description: "Skill name" }),
  success: Type.Boolean({ description: "Whether the skill execution succeeded" }),
  notes: Type.Optional(Type.String({ description: "Feedback notes" })),
  conversation_id: Type.Optional(Type.String({ description: "Conversation ID" })),
});

export function createSkillFeedbackTool(db: Kysely<Database>): InternalTool<TSchema> {
  return {
    name: "skill_feedback",
    description: "Record feedback on a skill execution for learning.",
    parameters: SkillFeedbackParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typedArgs = args as Static<typeof SkillFeedbackParams>;
      const id = typedArgs.name.toLowerCase().replace(/\s+/g, "-");

      try {
        const skill = await db
          .selectFrom("skills")
          .where("id", "=", id)
          .select(["id"])
          .executeTakeFirst();

        if (!skill) {
          return { output: `Skill "${typedArgs.name}" not found.` };
        }

        // Record execution feedback
        const executionId = nanoid(12);
        await db
          .insertInto("skill_executions")
          .values({
            id: executionId,
            skill_id: skill.id,
            conversation_id: typedArgs.conversation_id || "unknown",
            success: typedArgs.success ? 1 : 0,
            feedback_notes: typedArgs.notes || null,
            had_tool_errors: 0,
          })
          .execute();

        return {
          output: `Recorded feedback for "${typedArgs.name}": ${typedArgs.success ? "success" : "failure"}${typedArgs.notes ? ` — "${typedArgs.notes}"` : ""}`,
          details: { executionId },
        };
      } catch (err) {
        throw new Error(
          `Failed to record feedback: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}
