import { Type, type Static } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toolLog } from "../../logger.js";

const exec = promisify(execFile);

const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 8_000;

const ShellParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to execute. Passed to /bin/sh -c, so pipes, redirects, and chaining work.",
  }),
  working_directory: Type.Optional(
    Type.String({
      description: "Working directory for the command. Defaults to the project root.",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
    }),
  ),
});

type ShellInput = Static<typeof ShellParams>;

export function createShellTool(projectRoot: string) {
  return {
    name: "shell",
    description:
      "Execute a shell command and return its output. Use for running CLI tools, package managers (npm/npx/pip), curl, git, file operations, or any system command that skills or tasks require.",
    parameters: ShellParams,
    execute: async (_toolCallId: string, args: ShellInput) => {
      const timeout = Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const cwd = args.working_directory ?? projectRoot;

      toolLog.info`shell: ${args.command} (cwd=${cwd}, timeout=${timeout}ms)`;

      try {
        const { stdout, stderr } = await exec("/bin/sh", ["-c", args.command], {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024, // 1 MB
          env: process.env,
        });

        const combined = formatOutput(stdout, stderr);

        return {
          output: combined || "(no output)",
          details: { exit_code: 0 },
        };
      } catch (err) {
        const e = err as Error & {
          code?: number | string;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };

        if (e.killed) {
          return {
            output: `Command timed out after ${timeout}ms.\n${formatOutput(e.stdout, e.stderr)}`,
            details: { exit_code: null, timed_out: true },
          };
        }

        const exitCode = typeof e.code === "number" ? e.code : 1;
        const combined = formatOutput(e.stdout, e.stderr) || e.message;

        return {
          output: `Exit code ${exitCode}:\n${combined}`,
          details: { exit_code: exitCode },
        };
      }
    },
  };
}

function formatOutput(stdout?: string, stderr?: string): string {
  const parts: string[] = [];
  if (stdout?.trim()) parts.push(stdout.trim());
  if (stderr?.trim()) parts.push(`[stderr] ${stderr.trim()}`);
  const combined = parts.join("\n");
  if (combined.length > MAX_OUTPUT_CHARS) {
    return `${combined.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated, ${combined.length} total chars)`;
  }
  return combined;
}
