import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { nanoid } from "nanoid";
import { extractInstructions, resolveDependencyIds } from "../../extensions/instructions.js";
import { detectConflicts } from "../../skills/discovery.js";

const SkillParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("list"),
      Type.Literal("delete"),
      Type.Literal("inspect"),
      Type.Literal("feedback"),
      Type.Literal("conflicts"),
    ],
    {
      description:
        'Action: "create" a skill, "update" body/description, "list" all, "delete" (deprecate), "inspect" details, "feedback" on execution, "conflicts" detect contradictions',
    },
  ),
  name: Type.Optional(
    Type.String({ description: "Skill name (for create/update/delete/inspect/feedback)" }),
  ),
  description: Type.Optional(Type.String({ description: "Skill description (for create/update)" })),
  body: Type.Optional(Type.String({ description: "Skill body in markdown (for create/update)" })),
  success: Type.Optional(
    Type.Boolean({ description: "For feedback: whether execution succeeded" }),
  ),
  notes: Type.Optional(Type.String({ description: "For feedback: optional notes" })),
  conversation_id: Type.Optional(
    Type.String({ description: "For feedback: optional conversation ID" }),
  ),
});

type SkillInput = Static<typeof SkillParams>;

export function createSkillTool(db: Kysely<Database>, apiKey?: string, embeddingModel?: string) {
  return {
    name: "skill" as const,
    description:
      'Manage living skills. Actions: "create" (new skill with auto-extracted instructions), "update" (revise body/description), "list" (all active), "delete" (deprecate), "inspect" (instructions + history), "feedback" (record execution outcome), "conflicts" (detect contradictory instructions).',
    parameters: SkillParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as SkillInput;

      switch (typed.action) {
        case "create": {
          if (!typed.name || !typed.description || !typed.body) {
            return {
              output: 'The "create" action requires "name", "description", and "body" parameters.',
              details: { error: "missing_params" },
            };
          }

          const id = typed.name.toLowerCase().replace(/\s+/g, "-");

          const existing = await db
            .selectFrom("skills")
            .where("name", "=", typed.name)
            .select(["id"])
            .executeTakeFirst();

          if (existing) {
            return {
              output: `Skill "${typed.name}" already exists. Use action "update" to modify it.`,
            };
          }

          try {
            await db
              .insertInto("skills")
              .values({
                id,
                name: typed.name,
                description: typed.description,
                body: typed.body,
                version: 1,
                status: "active",
                use_count: 0,
              })
              .execute();

            if (apiKey) {
              const extracted = await extractInstructions(
                apiKey,
                typed.name,
                typed.body,
                embeddingModel,
              );

              const instructionIds = extracted.instructions.map(() => nanoid(12));

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
                output: `Created skill "${typed.name}" with ${extracted.instructions.length} instructions extracted.`,
                details: { skillId: id, instructionCount: extracted.instructions.length },
              };
            }

            return {
              output: `Created skill "${typed.name}". No API key available for instruction extraction — use shell to reload.`,
              details: { skillId: id },
            };
          } catch (err) {
            throw new Error(
              `Failed to create skill: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
        }

        case "update": {
          if (!typed.name) {
            return {
              output: 'The "update" action requires a "name" parameter.',
              details: { error: "missing_params" },
            };
          }

          const id = typed.name.toLowerCase().replace(/\s+/g, "-");

          const existing = await db
            .selectFrom("skills")
            .where("id", "=", id)
            .select(["id", "version", "body"])
            .executeTakeFirst();

          if (!existing) {
            return { output: `Skill "${typed.name}" not found.` };
          }

          const newVersion = existing.version + 1;
          const updateData: Record<string, unknown> = {
            version: newVersion,
            updated_at: new Date().toISOString(),
          };

          const bodyChanged = typed.body !== undefined;

          if (bodyChanged) {
            updateData.body = typed.body;
            updateData.parent_id = existing.id;
          }

          if (typed.description !== undefined) {
            updateData.description = typed.description;
          }

          try {
            await db.updateTable("skills").set(updateData).where("id", "=", id).execute();

            if (bodyChanged && apiKey) {
              const extracted = await extractInstructions(
                apiKey,
                typed.name,
                typed.body!,
                embeddingModel,
              );

              const oldInstructionIds = await db
                .selectFrom("skill_instructions")
                .select("id")
                .where("skill_id", "=", id)
                .execute();

              const instrIds = oldInstructionIds.map((r) => r.id);
              if (instrIds.length > 0) {
                await db
                  .deleteFrom("skill_instruction_deps")
                  .where("from_id", "in", instrIds)
                  .execute();
                await db
                  .deleteFrom("skill_instruction_deps")
                  .where("to_id", "in", instrIds)
                  .execute();
              }

              await db.deleteFrom("skill_instructions").where("skill_id", "=", id).execute();

              const instructionIds = extracted.instructions.map(() => nanoid(12));
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
                output: `Updated skill "${typed.name}" to v${newVersion} with ${extracted.instructions.length} instructions re-extracted.`,
                details: {
                  skillId: id,
                  newVersion,
                  instructionCount: extracted.instructions.length,
                },
              };
            }

            return {
              output: `Updated skill "${typed.name}" to v${newVersion}${bodyChanged && !apiKey ? ". No API key for instruction extraction." : "."}`,
              details: { skillId: id, newVersion },
            };
          } catch (err) {
            throw new Error(
              `Failed to update skill: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
        }

        case "list": {
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
              { cause: err },
            );
          }
        }

        case "delete": {
          if (!typed.name) {
            return {
              output: 'The "delete" action requires a "name" parameter.',
              details: { error: "missing_params" },
            };
          }

          const id = typed.name.toLowerCase().replace(/\s+/g, "-");

          try {
            await db
              .updateTable("skills")
              .set({ status: "deprecated" })
              .where("id", "=", id)
              .execute();

            return {
              output: `Deprecated skill "${typed.name}".`,
              details: { skillId: id },
            };
          } catch (err) {
            throw new Error(
              `Failed to delete skill: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
        }

        case "inspect": {
          if (!typed.name) {
            return {
              output: 'The "inspect" action requires a "name" parameter.',
              details: { error: "missing_params" },
            };
          }

          const id = typed.name.toLowerCase().replace(/\s+/g, "-");

          try {
            const skill = await db
              .selectFrom("skills")
              .where("id", "=", id)
              .select([
                "id",
                "name",
                "description",
                "version",
                "use_count",
                "created_at",
                "updated_at",
              ])
              .executeTakeFirst();

            if (!skill) {
              return { output: `Skill "${typed.name}" not found.` };
            }

            const instructions = await db
              .selectFrom("skill_instructions")
              .where("skill_id", "=", skill.id)
              .select(["id", "instruction", "position"])
              .orderBy("position")
              .execute();

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
              details: { skill, instructions, executions },
            };
          } catch (err) {
            throw new Error(
              `Failed to inspect skill: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
        }

        case "feedback": {
          if (!typed.name || typed.success === undefined) {
            return {
              output: 'The "feedback" action requires "name" and "success" parameters.',
              details: { error: "missing_params" },
            };
          }

          const id = typed.name.toLowerCase().replace(/\s+/g, "-");

          try {
            const skill = await db
              .selectFrom("skills")
              .where("id", "=", id)
              .select(["id"])
              .executeTakeFirst();

            if (!skill) {
              return { output: `Skill "${typed.name}" not found.` };
            }

            const executionId = nanoid(12);
            await db
              .insertInto("skill_executions")
              .values({
                id: executionId,
                skill_id: skill.id,
                conversation_id: typed.conversation_id || "unknown",
                success: typed.success ? 1 : 0,
                feedback_notes: typed.notes || null,
                had_tool_errors: 0,
              })
              .execute();

            return {
              output: `Recorded feedback for "${typed.name}": ${typed.success ? "success" : "failure"}${typed.notes ? ` — "${typed.notes}"` : ""}`,
              details: { executionId },
            };
          } catch (err) {
            throw new Error(
              `Failed to record feedback: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
        }

        case "conflicts": {
          if (!apiKey) {
            return {
              output: 'The "conflicts" action requires an API key for embedding similarity.',
              details: { error: "no_api_key" },
            };
          }

          try {
            const conflicts = await detectConflicts(db, apiKey, embeddingModel);

            if (conflicts.length === 0) {
              return { output: "No conflicting instructions detected." };
            }

            let output = `Found ${conflicts.length} potential conflict(s):\n\n`;
            for (const conflict of conflicts) {
              output += `**${conflict.conflictType} conflict** (${(conflict.similarity * 100).toFixed(0)}% match)\n`;
              output += `Skill A: ${conflict.instructionA.skillId}\n`;
              output += `  "${conflict.instructionA.text}"\n`;
              output += `Skill B: ${conflict.instructionB.skillId}\n`;
              output += `  "${conflict.instructionB.text}"\n\n`;
            }

            return {
              output,
              details: { conflictCount: conflicts.length, conflicts },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to detect conflicts: ${msg}`, { cause: err });
          }
        }

        default:
          return {
            output: `Unknown action: ${typed.action}`,
            details: { error: "unknown_action" },
          };
      }
    },
  };
}
