import { Type, type Static } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;

const IdentityReadParams = Type.Object({
  file: Type.Union(
    IDENTITY_FILES.map((f) => Type.Literal(f)),
    {
      description: "Which identity file to read",
    },
  ),
});

type IdentityReadInput = Static<typeof IdentityReadParams>;

export function createIdentityReadTool(extensionsDir: string) {
  return {
    name: "identity_read",
    description:
      "Read an identity file (SOUL.md, IDENTITY.md, or USER.md). Use this to review current personality, identity, or user context before updating.",
    parameters: IdentityReadParams,
    execute: async (_toolCallId: string, args: IdentityReadInput) => {
      const filePath = join(extensionsDir, args.file);
      try {
        const content = await readFile(filePath, "utf-8");
        return {
          output: content,
          details: { file: args.file, length: content.length },
        };
      } catch {
        return {
          output: `${args.file} does not exist yet. Use identity_update to create it.`,
          details: { file: args.file, exists: false },
        };
      }
    },
  };
}
