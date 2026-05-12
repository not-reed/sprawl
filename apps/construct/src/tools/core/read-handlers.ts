import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative, join } from "node:path";

export const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;
export type IdentityFile = (typeof IDENTITY_FILES)[number];

export interface ReadContext {
  projectRoot: string;
  extensionsDir?: string;
}

export interface ReadArgs {
  action: string;
  path?: string;
  file?: string;
}

export interface HandlerResult {
  output: string;
  details?: unknown;
}

interface ResolvedPath {
  resolved: string;
  displayPath: string;
}

const ALLOWED_ROOT_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "CLAUDE.md",
  "PLAN.md",
  "Justfile",
  "pnpm-workspace.yaml",
]);

/** Reject .env files, node_modules, and hidden dotfiles. */
const BLOCKED_PATTERNS = [
  /\.env/i,
  /node_modules/,
  /\/\./, // any segment starting with .
];

function isBlockedPath(relPath: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(relPath));
}

function resolveReadPath(
  ctx: ReadContext,
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
  const allowed =
    rel.startsWith("apps/") || rel.startsWith("packages/") || ALLOWED_ROOT_FILES.has(rel);

  if (!allowed || rel.startsWith("..")) {
    return {
      error: {
        output: `Access denied: "${inputPath}" is outside the allowed scope (apps/, packages/, extensions/, config files).`,
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

export async function handleIdentity(ctx: ReadContext, args: ReadArgs): Promise<HandlerResult> {
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
  const filePath = join(ctx.extensionsDir, args.file);
  try {
    const content = await readFile(filePath, "utf-8");
    return { output: content, details: { file: args.file, length: content.length } };
  } catch {
    return {
      output: `${args.file} does not exist yet. Use the edit tool to create it.`,
      details: { file: args.file, exists: false },
    };
  }
}

export async function handleFileOrDirectory(
  ctx: ReadContext,
  args: ReadArgs,
): Promise<HandlerResult> {
  if (!args.path) {
    return {
      output: `The "${args.action}" action requires a "path" parameter.`,
      details: { error: "missing_params" },
    };
  }

  const path = resolveReadPath(ctx, args.path);
  if ("error" in path) return path.error;
  const { resolved, displayPath } = path;

  try {
    const info = await stat(resolved);
    if (info.isDirectory()) {
      const entries = await readdir(resolved, { withFileTypes: true });
      const listing = entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`).join("\n");
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
    return { output: `Error reading "${args.path}": ${msg}`, details: { error: msg } };
  }
}
