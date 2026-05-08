import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, dirname, join } from "node:path";
import type { Database } from "../../db/schema.js";
import { getLastResolvedAsk } from "../../db/queries.js";
import { reloadExtensions } from "../../extensions/index.js";
import { invalidateSystemPromptCache } from "../../system-prompt.js";

const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;

const REJECTION_PATTERNS = /\b(no|nah|nope|don'?t|cancel|stop|not now|hold off|skip|never mind)\b/i;

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
      {
        description: 'For "identity" action: which file to update.',
      },
    ),
  ),
  content: Type.Optional(
    Type.String({
      description: 'For "identity" action: full markdown content for the file.',
    }),
  ),
});

type EditInput = Static<typeof EditParams>;

export function createEditTool(
  projectRoot: string,
  extensionsDir?: string,
  db?: Kysely<Database>,
  chatId?: string,
) {
  return {
    name: "edit" as const,
    description:
      'Edit files or identity documents. "source" uses search-and-replace on source/extension files (empty search + new path creates a file). "identity" updates SOUL.md/IDENTITY.md/USER.md with immediate prompt effect.',
    parameters: EditParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as EditInput;

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
          if (!typed.content) {
            return {
              output: 'The "identity" action requires a "content" parameter.',
              details: { error: "missing_params" },
            };
          }

          const filePath = join(extensionsDir, identityFile);

          let previous: string | null = null;
          try {
            previous = await readFile(filePath, "utf-8");
          } catch {
            // File doesn't exist yet
          }

          await mkdir(extensionsDir, { recursive: true });
          await writeFile(filePath, typed.content, "utf-8");

          invalidateSystemPromptCache();
          await reloadExtensions();

          const action = previous === null ? "Created" : "Updated";
          return {
            output: `${action} ${identityFile} (${typed.content.length} chars).`,
            details: {
              file: identityFile,
              action: action.toLowerCase(),
              length: typed.content.length,
            },
          };
        }

        case "source": {
          if (!typed.path) {
            return {
              output: 'The "source" action requires a "path" parameter.',
              details: { error: "missing_params" },
            };
          }
          if (typed.search === undefined || typed.replace === undefined) {
            return {
              output: 'The "source" action requires "search" and "replace" parameters.',
              details: { error: "missing_params" },
            };
          }

          // Check if the user recently rejected a proposal via telegram_ask
          if (db && chatId) {
            const lastAsk = await getLastResolvedAsk(db, chatId);
            if (lastAsk && lastAsk.response && lastAsk.response !== "[superseded]") {
              const isRejection = REJECTION_PATTERNS.test(lastAsk.response);
              if (isRejection) {
                return {
                  output: `Edit blocked: user rejected the last proposal ("${lastAsk.question}" → "${lastAsk.response}"). Ask again or get explicit approval before editing.`,
                  details: { error: "rejected_proposal", askId: lastAsk.id },
                };
              }
            }
          }

          // Resolve extensions/ prefix against extensionsDir
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

            if (
              (!rel.startsWith("apps/") && !rel.startsWith("packages/")) ||
              rel.startsWith("..")
            ) {
              return {
                output: `Access denied: "${typed.path}" is outside the allowed scope (apps/, packages/, extensions/).`,
                details: { error: "scope_violation" },
              };
            }
          }

          try {
            // File creation: empty search + file doesn't exist
            if (typed.search === "") {
              let fileExists = true;
              try {
                await readFile(resolved, "utf-8");
              } catch {
                fileExists = false;
              }

              if (!fileExists) {
                await mkdir(dirname(resolved), { recursive: true });
                await writeFile(resolved, typed.replace, "utf-8");
                return {
                  output: `Created ${displayPath}`,
                  details: { path: displayPath, created: true },
                };
              }

              return {
                output: `File ${displayPath} already exists. Provide a non-empty search string to edit it, or use a new path to create a file.`,
                details: { error: "file_exists" },
              };
            }

            const content = await readFile(resolved, "utf-8");

            const occurrences = content.split(typed.search).length - 1;
            if (occurrences === 0) {
              return {
                output: `Search string not found in ${displayPath}. Make sure you're using the exact text from the file.`,
                details: { error: "not_found" },
              };
            }
            if (occurrences > 1) {
              return {
                output: `Search string found ${occurrences} times in ${displayPath}. It must be unique — provide more surrounding context to disambiguate.`,
                details: { error: "ambiguous", occurrences },
              };
            }

            const newContent = content.replace(typed.search, typed.replace);
            await writeFile(resolved, newContent, "utf-8");

            return {
              output: `Edited ${displayPath}: replaced 1 occurrence.`,
              details: { path: displayPath, replaced: true },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              output: `Error editing "${typed.path}": ${msg}`,
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
