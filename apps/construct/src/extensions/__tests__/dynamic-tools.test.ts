import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDynamicTools } from "../loader.js";
import type { DynamicToolContext } from "../types.js";

describe("loadDynamicTools", () => {
  let tmpDir: string;
  const toolCtx: DynamicToolContext = { secrets: new Map() };
  const availableSecrets = new Set<string>();

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ext-dyn-"));
    await mkdir(join(tmpDir, "tools"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("returns empty when tools/ has no files", async () => {
    const packs = await loadDynamicTools(tmpDir, toolCtx, availableSecrets);
    expect(packs).toEqual([]);
  });

  it("returns empty when tools/ does not exist", async () => {
    await rm(join(tmpDir, "tools"), { recursive: true });
    const packs = await loadDynamicTools(tmpDir, toolCtx, availableSecrets);
    expect(packs).toEqual([]);
  });

  it("loads a standalone tool file as a single-tool pack", async () => {
    await writeFile(
      join(tmpDir, "tools", "echo.ts"),
      `import { Type } from '@sinclair/typebox'

export default function create(ctx) {
  return {
    name: 'echo',
    description: 'Echo back the input',
    parameters: Type.Object({
      text: Type.String({ description: 'Text to echo' }),
    }),
    execute: async (_id, args) => {
      return { output: args.text }
    },
  }
}`,
    );

    const packs = await loadDynamicTools(tmpDir, toolCtx, availableSecrets);
    expect(packs).toHaveLength(1);
    expect(packs[0].name).toBe("ext:echo");
    expect(packs[0].factories).toHaveLength(1);

    // Instantiate and test the tool
    const tool = packs[0].factories[0]({} as any);
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("echo");
  });

  it("groups directory tools into a pack", async () => {
    await mkdir(join(tmpDir, "tools", "utils"), { recursive: true });
    await writeFile(
      join(tmpDir, "tools", "utils", "upper.ts"),
      `import { Type } from '@sinclair/typebox'

export default {
  name: 'upper',
  description: 'Uppercase a string',
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_id, args) => ({ output: args.text.toUpperCase() }),
}`,
    );

    const packs = await loadDynamicTools(tmpDir, toolCtx, availableSecrets);
    expect(packs).toHaveLength(1);
    expect(packs[0].name).toBe("ext:utils");
  });

  it("uses pack.md for description when present", async () => {
    await mkdir(join(tmpDir, "tools", "mypack"), { recursive: true });
    await writeFile(join(tmpDir, "tools", "mypack", "pack.md"), "Custom pack description");
    await writeFile(
      join(tmpDir, "tools", "mypack", "tool.ts"),
      `import { Type } from '@sinclair/typebox'

export default {
  name: 'mytool',
  description: 'A tool',
  parameters: Type.Object({}),
  execute: async () => ({ output: 'ok' }),
}`,
    );

    const packs = await loadDynamicTools(tmpDir, toolCtx, availableSecrets);
    expect(packs[0].description).toBe("Custom pack description");
  });

  it("skips tools with unmet secret requirements", async () => {
    await writeFile(
      join(tmpDir, "tools", "needs-secret.ts"),
      `import { Type } from '@sinclair/typebox'

export const meta = {
  requires: { secrets: ['MISSING_KEY'] },
}

export default {
  name: 'needs_secret',
  description: 'Needs a secret',
  parameters: Type.Object({}),
  execute: async () => ({ output: 'ok' }),
}`,
    );

    const packs = await loadDynamicTools(tmpDir, toolCtx, availableSecrets);
    expect(packs).toEqual([]);
  });

  it("loads tools when secret requirements are met", async () => {
    await writeFile(
      join(tmpDir, "tools", "has-secret.ts"),
      `import { Type } from '@sinclair/typebox'

export const meta = {
  requires: { secrets: ['MY_KEY'] },
}

export default function create(ctx) {
  return {
    name: 'has_secret',
    description: 'Has a secret',
    parameters: Type.Object({}),
    execute: async () => ({ output: ctx.secrets.get('MY_KEY') || 'missing' }),
  }
}`,
    );

    const secretsMap = new Map([["MY_KEY", "secret_value"]]);
    const secrets = new Set(["MY_KEY"]);
    const packs = await loadDynamicTools(tmpDir, { secrets: secretsMap }, secrets);
    expect(packs).toHaveLength(1);
  });
});
