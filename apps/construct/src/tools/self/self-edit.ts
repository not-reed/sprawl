import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import type { Database } from "../../db/schema.js";
import { getLastResolvedAsk } from "../../db/queries.js";

/** Negative response patterns — matches common rejection phrases. */
const REJECTION_PATTERNS = /\b(no|nah|nope|don'?t|cancel|stop|not now|hold off|skip|never mind)\b/i;

const SelfEditParams = Type.Object({
  path: Type.String({
    description:
      'File path relative to project root (e.g. "apps/construct/src/agent.ts", "packages/cairn/src/index.ts") or extensions directory (e.g. "extensions/skills/standup.md")',
  }),
  search: Type.String({
    description:
      "Exact string to find in the file (must be unique). Use empty string to create a new file.",
  }),
  replace: Type.String({
    description: "String to replace the search match with, or full content for new files",
  }),
});

type SelfEditInput = Static<typeof SelfEditParams>;

export function createSelfEditTool(
  projectRoot: string,
  extensionsDir?: string,
  db?: Kysely<Database>,
  chatId?: string,
) {
  return {
    name: "self_edit_source",
    description:
      "Edit your own source files or extension files using search-and-replace. Use empty search string with a path that doesn't exist to create a new file. Allowed scopes: apps/, packages/, extensions/.",
    parameters: SelfEditParams,
    execute: async (_toolCallId: string, args: SelfEditInput) => {
      // Check if the user recently rejected a proposal via telegram_ask
      if (db && chatId) {
        const lastAsk = await getLastResolvedAsk(db, chatId);
        if (lastAsk && lastAsk.response && lastAsk.response !== "[superseded]") {
          // Check if options were provided (button-based ask)
          const options = lastAsk.options ? (JSON.parse(lastAsk.options) as string[]) : null;
          let isRejection = false;

          if (options) {
            // Button-based: check if selected option looks negative
            isRejection = REJECTION_PATTERNS.test(lastAsk.response);
          } else {
            // Free-form text: check for rejection patterns
            isRejection = REJECTION_PATTERNS.test(lastAsk.response);
          }

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

      if (args.path.startsWith("extensions/") && extensionsDir) {
        const extRelative = args.path.slice("extensions/".length);
        resolved = resolve(extensionsDir, extRelative);
        displayPath = args.path;

        // Scope check: prevent path traversal out of extensions dir
        if (
          !resolved.startsWith(resolve(extensionsDir) + "/") &&
          resolved !== resolve(extensionsDir)
        ) {
          return {
            output: `Access denied: "${args.path}" escapes the extensions directory.`,
            details: { error: "scope_violation" },
          };
        }
      } else {
        resolved = resolve(projectRoot, args.path);
        const rel = relative(projectRoot, resolved);
        displayPath = rel;

        // Scope check: only allow apps/ and packages/
        if ((!rel.startsWith("apps/") && !rel.startsWith("packages/")) || rel.startsWith("..")) {
          return {
            output: `Access denied: "${args.path}" is outside the allowed scope (src/, cli/, extensions/).`,
            details: { error: "scope_violation" },
          };
        }
      }

      try {
        // File creation: empty search + file doesn't exist
        if (args.search === "") {
          let fileExists = true;
          try {
            await readFile(resolved, "utf-8");
          } catch {
            fileExists = false;
          }

          if (!fileExists) {
            // Create the file (and parent dirs)
            await mkdir(dirname(resolved), { recursive: true });
            await writeFile(resolved, args.replace, "utf-8");
            return {
              output: `Created ${displayPath}`,
              details: { path: displayPath, created: true },
            };
          }

          // File exists but search is empty — this is ambiguous
          return {
            output: `File ${displayPath} already exists. Provide a non-empty search string to edit it, or use a new path to create a file.`,
            details: { error: "file_exists" },
          };
        }

        const content = await readFile(resolved, "utf-8");

        const occurrences = content.split(args.search).length - 1;
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

        const newContent = content.replace(args.search, args.replace);
        await writeFile(resolved, newContent, "utf-8");

        return {
          output: `Edited ${displayPath}: replaced 1 occurrence.`,
          details: { path: displayPath, replaced: true },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          output: `Error editing "${args.path}": ${msg}`,
          details: { error: msg },
        };
      }
    },
  };
}
