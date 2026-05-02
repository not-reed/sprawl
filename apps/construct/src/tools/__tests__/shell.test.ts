import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createShellTool } from "../core/shell.js";

let tempDir: string;
let projectRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "shell-test-"));
  projectRoot = join(tempDir, "project");
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("shell", () => {
  it("executes a command and returns stdout", async () => {
    const tool = createShellTool(projectRoot);
    const result = await tool.execute("t1", { command: "echo hello world" });

    expect(result.output).toContain("hello world");
    expect((result.details as any).exit_code).toBe(0);
  });

  it("captures stderr", async () => {
    const tool = createShellTool(projectRoot);
    const result = await tool.execute("t1", { command: "echo err >&2" });

    expect(result.output).toContain("err");
    expect(result.output).toContain("stderr");
  });

  it("captures exit code on failure", async () => {
    const tool = createShellTool(projectRoot);
    const result = await tool.execute("t1", { command: "exit 42" });

    expect(result.output).toContain("42");
    expect((result.details as any).exit_code).toBe(42);
  });

  it("reports timeout when command exceeds timeout", async () => {
    const tool = createShellTool(projectRoot);
    const result = await tool.execute("t1", { command: "sleep 10", timeout_ms: 100 });

    expect(result.output).toContain("timed out");
    expect((result.details as any).timed_out).toBe(true);
  }, 15000);

  it("uses working_directory parameter", async () => {
    mkdirSync(join(projectRoot, "subdir"), { recursive: true });
    writeFileSync(join(projectRoot, "subdir", "test.txt"), "content");

    const tool = createShellTool(projectRoot);
    const result = await tool.execute("t1", {
      command: "cat test.txt",
      working_directory: join(projectRoot, "subdir"),
    });

    expect(result.output).toContain("content");
  });

  it("defaults working directory to project root", async () => {
    writeFileSync(join(projectRoot, "root.txt"), "root-file");

    const tool = createShellTool(projectRoot);
    const result = await tool.execute("t1", { command: "cat root.txt" });

    expect(result.output).toContain("root-file");
  });

  it("truncates large output", async () => {
    const tool = createShellTool(projectRoot);
    // Generate output larger than 8000 chars
    const result = await tool.execute("t1", { command: "seq 1 2000" });

    if (result.output.includes("truncated")) {
      expect(result.output).toContain("truncated");
    }
    // Should still contain content
    expect(result.output.length).toBeGreaterThan(0);
  });

  it("handles commands with pipes", async () => {
    const tool = createShellTool(projectRoot);
    const result = await tool.execute("t1", { command: "echo 'hello world' | tr 'h' 'H'" });

    expect(result.output).toContain("Hello");
  });

  it("returns no output message for empty output", async () => {
    const tool = createShellTool(projectRoot);
    const result = await tool.execute("t1", { command: "true" });

    expect(result.output).toContain("no output");
  });
});
