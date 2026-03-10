import { Type, type Static } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const SelfTestParams = Type.Object({
  filter: Type.Optional(
    Type.String({
      description: 'Test name filter (e.g. "memory" to only run memory tests)',
    }),
  ),
});

type SelfTestInput = Static<typeof SelfTestParams>;

export function createSelfTestTool(projectRoot: string) {
  return {
    name: "self_run_tests",
    description:
      "Run your own test suite using vitest. Returns pass/fail results. Use this before deploying any self-edit.",
    parameters: SelfTestParams,
    execute: async (_toolCallId: string, args: SelfTestInput) => {
      const cmdArgs = ["vitest", "run", "--reporter=verbose"];
      if (args.filter) {
        cmdArgs.push("-t", args.filter);
      }

      try {
        const { stdout, stderr } = await exec("npx", cmdArgs, {
          cwd: projectRoot,
          timeout: 60_000,
          env: { ...process.env, NODE_ENV: "test" },
        });

        const output = stdout + (stderr ? `\n${stderr}` : "");
        const passed = output.includes("Tests  ") && !output.includes("failed");

        return {
          output: `Tests ${passed ? "PASSED" : "FAILED"}:\n${output.slice(-2000)}`,
          details: { passed, full_output: output },
        };
      } catch (err) {
        const msg =
          err instanceof Error
            ? ((err as Error & { stdout?: string; stderr?: string }).stdout ??
              (err as Error & { stderr?: string }).stderr ??
              err.message)
            : String(err);

        return {
          output: `Tests FAILED:\n${String(msg).slice(-2000)}`,
          details: { passed: false, error: msg },
        };
      }
    },
  };
}
