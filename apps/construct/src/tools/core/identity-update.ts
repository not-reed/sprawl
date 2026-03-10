import { Type, type Static } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { reloadExtensions } from "../../extensions/index.js";
import { invalidateSystemPromptCache } from "../../system-prompt.js";

const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;

const IdentityUpdateParams = Type.Object({
  file: Type.Union(
    IDENTITY_FILES.map((f) => Type.Literal(f)),
    {
      description: "Which identity file to update",
    },
  ),
  content: Type.String({
    description: "Full markdown content for the file",
  }),
});

type IdentityUpdateInput = Static<typeof IdentityUpdateParams>;

export function createIdentityUpdateTool(extensionsDir: string) {
  return {
    name: "identity_update",
    description:
      "Create or overwrite an identity file (SOUL.md, IDENTITY.md, or USER.md). These are living documents — update them as the relationship evolves. Changes take effect immediately in the system prompt.",
    parameters: IdentityUpdateParams,
    execute: async (_toolCallId: string, args: IdentityUpdateInput) => {
      const filePath = join(extensionsDir, args.file);

      // Read previous content for diff summary
      let previous: string | null = null;
      try {
        previous = await readFile(filePath, "utf-8");
      } catch {
        // File doesn't exist yet
      }

      await mkdir(extensionsDir, { recursive: true });
      await writeFile(filePath, args.content, "utf-8");

      // Reload extensions and invalidate prompt cache so changes take effect
      invalidateSystemPromptCache();
      await reloadExtensions();

      const action = previous === null ? "Created" : "Updated";
      return {
        output: `${action} ${args.file} (${args.content.length} chars).`,
        details: { file: args.file, action: action.toLowerCase(), length: args.content.length },
      };
    },
  };
}
