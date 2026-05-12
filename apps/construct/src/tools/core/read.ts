import { Type, type Static } from "@sinclair/typebox";
import {
  type HandlerResult,
  type ReadArgs,
  type ReadContext,
  IDENTITY_FILES,
  handleFileOrDirectory,
  handleIdentity,
} from "./read-handlers.js";

const ReadParams = Type.Object({
  action: Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("identity")], {
    description:
      'Action: "file" to read a source file, "directory" to list a directory, "identity" to read a personality file (SOUL.md, IDENTITY.md, USER.md)',
  }),
  path: Type.Optional(
    Type.String({
      description:
        'Path for "file" or "directory" action. Relative to project root (e.g. "apps/construct/src/agent.ts") or extensions dir (e.g. "extensions/skills/standup.md").',
    }),
  ),
  file: Type.Optional(
    Type.Union(
      IDENTITY_FILES.map((f) => Type.Literal(f)),
      {
        description: 'Identity file name for "identity" action: SOUL.md, IDENTITY.md, or USER.md',
      },
    ),
  ),
});

type ReadInput = Static<typeof ReadParams>;

const handlers: Record<
  ReadInput["action"],
  (ctx: ReadContext, args: ReadArgs) => Promise<HandlerResult>
> = {
  identity: handleIdentity,
  file: handleFileOrDirectory,
  directory: handleFileOrDirectory,
};

export function createReadTool(projectRoot: string, extensionsDir?: string) {
  const ctx: ReadContext = { projectRoot, extensionsDir };

  return {
    name: "read" as const,
    description:
      'Read files, list directories, or view identity documents. Actions: "file" reads a source file, "directory" lists directory contents, "identity" reads SOUL.md/IDENTITY.md/USER.md.',
    parameters: ReadParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as ReadInput;
      const handler = handlers[typed.action];
      if (!handler) {
        return { output: `Unknown action: ${typed.action}`, details: { error: "unknown_action" } };
      }
      return handler(ctx, typed);
    },
  };
}
