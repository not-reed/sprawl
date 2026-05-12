import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, dirname, join } from "node:path";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { getLastResolvedAsk } from "../../db/queries.js";
import { reloadExtensions } from "../../extensions/index.js";
import { invalidateSystemPromptCache } from "../../system-prompt.js";

export const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;
export type IdentityFile = (typeof IDENTITY_FILES)[number];

const REJECTION_PATTERNS = /\b(no|nah|nope|don'?t|cancel|stop|not now|hold off|skip|never mind)\b/i;

export interface EditContext {
  projectRoot: string;
  extensionsDir?: string;
  db?: Kysely<Database>;
  chatId?: string;
}

export interface EditArgs {
  action: string;
  path?: string;
  search?: string;
  replace?: string;
  file?: string;
  content?: string;
}

export interface HandlerResult {
  output: string;
  details?: unknown;
}

interface ResolvedPath {
  resolved: string;
  displayPath: string;
}

/** Reject .env files, node_modules, and hidden dotfiles. */
const BLOCKED_PATTERNS = [
  /\.env/i,
  /node_modules/,
  /\/\./, // any segment starting with .
];

function isBlockedPath(relPath: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(relPath));
}

function resolveSourcePath(
  ctx: EditContext,
  inputPath: string,
): ResolvedPath | { error: HandlerResult } {
  if (inputPath.startsWith("extensions/") && ctx.extensionsDir) {
    const extRelative = inputPath.slice("extensions/".length);
    const resolved = resolve(ctx.extensionsDir, extRelative);
    const extRoot = resolve(ctx.extensionsDir);
    if (!resolved.startsWith(extRoot + "/") && resolved !== extRoot) {
      return {
        error: {
          output: `Access denied: "${inputPath}" escapes the extensions directory.`,
          details: { error: "scope_violation" },
        },
      };
    }
    return { resolved, displayPath: inputPath };
  }

  const resolved = resolve(ctx.projectRoot, inputPath);
  const rel = relative(ctx.projectRoot, resolved);
  if ((!rel.startsWith("apps/") && !rel.startsWith("packages/")) || rel.startsWith("..")) {
    return {
      error: {
        output: `Access denied: "${inputPath}" is outside the allowed scope (apps/, packages/, extensions/).`,
        details: { error: "scope_violation" },
      },
    };
  }

  if (isBlockedPath(rel)) {
    return {
      error: {
        output: `Access denied: "${inputPath}" matches a blocked path pattern (.env, node_modules, hidden files).`,
        details: { error: "scope_violation" },
      },
    };
  }

  return { resolved, displayPath: rel };
}

async function checkRejectionGuard(ctx: EditContext): Promise<HandlerResult | null> {
  if (!ctx.db || !ctx.chatId) return null;
  const lastAsk = await getLastResolvedAsk(ctx.db, ctx.chatId);
  if (!lastAsk?.response || lastAsk.response === "[superseded]") return null;
  if (!REJECTION_PATTERNS.test(lastAsk.response)) return null;
  return {
    output: `Edit blocked: user rejected the last proposal ("${lastAsk.question}" → "${lastAsk.response}"). Ask again or get explicit approval before editing.`,
    details: { error: "rejected_proposal", askId: lastAsk.id },
  };
}

async function createNewFile(
  resolved: string,
  displayPath: string,
  replacement: string,
): Promise<HandlerResult> {
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, replacement, "utf-8");
  return { output: `Created ${displayPath}`, details: { path: displayPath, created: true } };
}

async function applyReplace(
  resolved: string,
  displayPath: string,
  search: string,
  replacement: string,
): Promise<HandlerResult> {
  const content = await readFile(resolved, "utf-8");
  const occurrences = content.split(search).length - 1;
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
  await writeFile(resolved, content.replace(search, replacement), "utf-8");
  return {
    output: `Edited ${displayPath}: replaced 1 occurrence.`,
    details: { path: displayPath, replaced: true },
  };
}

export async function handleSource(ctx: EditContext, args: EditArgs): Promise<HandlerResult> {
  if (!args.path) {
    return {
      output: 'The "source" action requires a "path" parameter.',
      details: { error: "missing_params" },
    };
  }
  if (args.search === undefined || args.replace === undefined) {
    return {
      output: 'The "source" action requires "search" and "replace" parameters.',
      details: { error: "missing_params" },
    };
  }

  const blocked = await checkRejectionGuard(ctx);
  if (blocked) return blocked;

  const path = resolveSourcePath(ctx, args.path);
  if ("error" in path) return path.error;
  const { resolved, displayPath } = path;

  try {
    if (args.search === "") {
      let exists = true;
      try {
        await readFile(resolved, "utf-8");
      } catch {
        exists = false;
      }
      if (!exists) return createNewFile(resolved, displayPath, args.replace);
      return {
        output: `File ${displayPath} already exists. Provide a non-empty search string to edit it, or use a new path to create a file.`,
        details: { error: "file_exists" },
      };
    }
    return applyReplace(resolved, displayPath, args.search, args.replace);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Error editing "${args.path}": ${msg}`, details: { error: msg } };
  }
}

export async function handleIdentity(ctx: EditContext, args: EditArgs): Promise<HandlerResult> {
  if (!ctx.extensionsDir) {
    return {
      output: "Extensions directory not configured.",
      details: { error: "no_extensions_dir" },
    };
  }
  if (!args.file || !IDENTITY_FILES.includes(args.file as IdentityFile)) {
    return {
      output: `Provide a valid file name: ${IDENTITY_FILES.join(", ")}`,
      details: { error: "invalid_file" },
    };
  }
  if (!args.content) {
    return {
      output: 'The "identity" action requires a "content" parameter.',
      details: { error: "missing_params" },
    };
  }

  const filePath = join(ctx.extensionsDir, args.file);
  let previous: string | null = null;
  try {
    previous = await readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist yet
  }

  await mkdir(ctx.extensionsDir, { recursive: true });
  await writeFile(filePath, args.content, "utf-8");

  invalidateSystemPromptCache();
  await reloadExtensions();

  const action = previous === null ? "Created" : "Updated";
  return {
    output: `${action} ${args.file} (${args.content.length} chars).`,
    details: { file: args.file, action: action.toLowerCase(), length: args.content.length },
  };
}
