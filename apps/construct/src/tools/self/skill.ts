import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import {
  type HandlerResult,
  type SkillArgs,
  type SkillContext,
  handleConflicts,
  handleCreate,
  handleDelete,
  handleFeedback,
  handleInspect,
  handleList,
  handleUpdate,
} from "./skill-handlers.js";

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

const handlers: Record<
  SkillInput["action"],
  (ctx: SkillContext, args: SkillArgs) => Promise<HandlerResult>
> = {
  create: handleCreate,
  update: handleUpdate,
  list: (ctx) => handleList(ctx),
  delete: handleDelete,
  inspect: handleInspect,
  feedback: handleFeedback,
  conflicts: (ctx) => handleConflicts(ctx),
};

export function createSkillTool(db: Kysely<Database>, apiKey?: string, embeddingModel?: string) {
  const ctx: SkillContext = { db, apiKey, embeddingModel };

  return {
    name: "skill" as const,
    description:
      'Manage living skills. Actions: "create" (new skill with auto-extracted instructions), "update" (revise body/description), "list" (all active), "delete" (deprecate), "inspect" (instructions + history), "feedback" (record execution outcome), "conflicts" (detect contradictory instructions).',
    parameters: SkillParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as SkillInput;
      const handler = handlers[typed.action];
      if (!handler) {
        return {
          output: `Unknown action: ${typed.action}`,
          details: { error: "unknown_action" },
        };
      }
      return handler(ctx, typed);
    },
  };
}
