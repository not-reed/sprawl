import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import {
  type EditArgs,
  type EditContext,
  type HandlerResult,
  IDENTITY_FILES,
  handleIdentity,
  handleSource,
} from "./edit-handlers.js";

const EditParams = Type.Object({
  action: Type.Union([Type.Literal("source"), Type.Literal("identity")], {
    description:
      'Action: "source" to edit a source file with search-and-replace, "identity" to update a personality file (SOUL.md, IDENTITY.md, USER.md)',
  }),
  path: Type.Optional(
    Type.String({
      description: 'File path for "source" action. Relative to project root or extensions dir.',
    }),
  ),
  search: Type.Optional(
    Type.String({
      description:
        'For "source" action: exact string to find (must be unique). Use empty string to create a new file.',
    }),
  ),
  replace: Type.Optional(
    Type.String({
      description: 'For "source" action: replacement string, or full content for new files.',
    }),
  ),
  file: Type.Optional(
    Type.Union(
      IDENTITY_FILES.map((f) => Type.Literal(f)),
      { description: 'For "identity" action: which file to update.' },
    ),
  ),
  content: Type.Optional(
    Type.String({ description: 'For "identity" action: full markdown content for the file.' }),
  ),
});

type EditInput = Static<typeof EditParams>;

const handlers: Record<
  EditInput["action"],
  (ctx: EditContext, args: EditArgs) => Promise<HandlerResult>
> = {
  source: handleSource,
  identity: handleIdentity,
};

export function createEditTool(
  projectRoot: string,
  extensionsDir?: string,
  db?: Kysely<Database>,
  chatId?: string,
) {
  const ctx: EditContext = { projectRoot, extensionsDir, db, chatId };

  return {
    name: "edit" as const,
    description:
      'Edit files or identity documents. "source" uses search-and-replace on source/extension files (empty search + new path creates a file). "identity" updates SOUL.md/IDENTITY.md/USER.md with immediate prompt effect.',
    parameters: EditParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as EditInput;
      const handler = handlers[typed.action];
      if (!handler) {
        return { output: `Unknown action: ${typed.action}`, details: { error: "unknown_action" } };
      }
      return handler(ctx, typed);
    },
  };
}
