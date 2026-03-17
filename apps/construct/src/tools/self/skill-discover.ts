import { Type, type TSchema } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { detectConflicts } from "../../skills/discovery.js";
import type { InternalTool } from "../packs.js";

// --- Tool: skill_conflicts ---

const SkillConflictsParams = Type.Object({});

export function createSkillConflictsTool(
  db: Kysely<Database>,
  apiKey: string,
  embeddingModel?: string,
): InternalTool<TSchema> {
  return {
    name: "skill_conflicts",
    description: "Detect contradictory instructions across active skills.",
    parameters: SkillConflictsParams,
    execute: async () => {
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
          details: {
            conflictCount: conflicts.length,
            conflicts,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to detect conflicts: ${msg}`, { cause: err });
      }
    },
  };
}
