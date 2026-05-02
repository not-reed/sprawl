import { Type, type Static } from "@sinclair/typebox";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative, join } from "node:path";

const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;

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

export function createReadTool(projectRoot: string, extensionsDir?: string) {
  return {
    name: "read" as const,
    description:
      'Read files, list directories, or view identity documents. Actions: "file" reads a source file, "directory" lists directory contents, "identity" reads SOUL.md/IDENTITY.md/USER.md.',
    parameters: ReadParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as ReadInput;

      switch (typed.action) {
        case "identity": {
          if (!extensionsDir) {
            return {
              output: "Extensions directory not configured.",
              details: { error: "no_extensions_dir" },
            };
          }
          const identityFile = typed.file;
          if (
            !identityFile ||
            !IDENTITY_FILES.includes(identityFile as (typeof IDENTITY_FILES)[number])
          ) {
            return {
              output: `Provide a valid file name: ${IDENTITY_FILES.join(", ")}`,
              details: { error: "invalid_file" },
            };
          }
          const filePath = join(extensionsDir, identityFile);
          try {
            const content = await readFile(filePath, "utf-8");
            return {
              output: content,
              details: { file: identityFile, length: content.length },
            };
          } catch {
            return {
              output: `${identityFile} does not exist yet. Use the edit tool to create it.`,
              details: { file: identityFile, exists: false },
            };
          }
        }

        case "file":
        case "directory": {
          if (!typed.path) {
            return {
              output: `The "${typed.action}" action requires a "path" parameter.`,
              details: { error: "missing_params" },
            };
          }

          let resolved: string;
          let displayPath: string;

          if (typed.path.startsWith("extensions/") && extensionsDir) {
            const extRelative = typed.path.slice("extensions/".length);
            resolved = resolve(extensionsDir, extRelative);
            displayPath = typed.path;

            if (
              !resolved.startsWith(resolve(extensionsDir) + "/") &&
              resolved !== resolve(extensionsDir)
            ) {
              return {
                output: `Access denied: "${typed.path}" escapes the extensions directory.`,
                details: { error: "scope_violation" },
              };
            }
          } else {
            resolved = resolve(projectRoot, typed.path);
            const rel = relative(projectRoot, resolved);
            displayPath = rel;

            const allowed =
              rel.startsWith("apps/") ||
              rel.startsWith("packages/") ||
              rel === "package.json" ||
              rel === "tsconfig.json" ||
              rel === "CLAUDE.md" ||
              rel === "PLAN.md" ||
              rel === "Justfile" ||
              rel === "pnpm-workspace.yaml";

            if (!allowed || rel.startsWith("..")) {
              return {
                output: `Access denied: "${typed.path}" is outside the allowed scope (apps/, packages/, extensions/, config files).`,
                details: { error: "scope_violation" },
              };
            }
          }

          try {
            const info = await stat(resolved);

            if (info.isDirectory()) {
              const entries = await readdir(resolved, { withFileTypes: true });
              const listing = entries
                .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
                .join("\n");
              return {
                output: `Directory listing for ${displayPath}/:\n${listing}`,
                details: { type: "directory", entries: entries.map((e) => e.name) },
              };
            }

            const content = await readFile(resolved, "utf-8");
            const lines = content.split("\n");
            return {
              output: `${displayPath} (${lines.length} lines):\n${content}`,
              details: { type: "file", path: displayPath, lines: lines.length },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              output: `Error reading "${typed.path}": ${msg}`,
              details: { error: msg },
            };
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
