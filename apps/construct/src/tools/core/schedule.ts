import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import {
  type HandlerResult,
  type ScheduleArgs,
  type ScheduleContext,
  handleCancel,
  handleCreate,
  handleList,
} from "./schedule-handlers.js";

const ScheduleParams = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel")], {
    description: 'Action: "create" a reminder, "list" existing reminders, "cancel" a reminder',
  }),
  description: Type.Optional(
    Type.String({ description: 'For "create": human-readable description of the reminder' }),
  ),
  instruction: Type.Optional(
    Type.String({ description: 'For "create": what the agent should do when the reminder fires' }),
  ),
  cron_expression: Type.Optional(
    Type.String({
      description: 'For "create": cron expression for recurring schedules (e.g. "0 9 * * 1")',
    }),
  ),
  run_at: Type.Optional(
    Type.String({
      description: 'For "create": datetime in local timezone, without Z or offset',
    }),
  ),
  active_only: Type.Optional(
    Type.Boolean({ description: 'For "list": only show active schedules (default: true)' }),
  ),
  id: Type.Optional(Type.String({ description: 'For "cancel": schedule ID to cancel' })),
});

type ScheduleInput = Static<typeof ScheduleParams>;

const handlers: Record<
  ScheduleInput["action"],
  (ctx: ScheduleContext, args: ScheduleArgs) => Promise<HandlerResult>
> = {
  create: handleCreate,
  list: handleList,
  cancel: handleCancel,
};

export function createScheduleTool(
  db: Kysely<Database>,
  chatId: string,
  timezone: string,
  apiKey: string,
  embeddingModel?: string,
) {
  const ctx: ScheduleContext = { db, chatId, timezone, apiKey, embeddingModel };

  return {
    name: "schedule" as const,
    description:
      'Schedule reminders and agent tasks. Actions: "create" (cron or one-shot), "list" existing, "cancel" by ID.',
    parameters: ScheduleParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as ScheduleInput;
      const handler = handlers[typed.action];
      if (!handler) {
        return { output: `Unknown action: ${typed.action}`, details: { error: "unknown_action" } };
      }
      return handler(ctx, typed);
    },
  };
}
