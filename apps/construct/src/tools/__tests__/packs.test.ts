import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Kysely } from "kysely";
import { createDb } from "@repo/db";
import type { Database } from "../../db/schema.js";
import { createAllTools, type ToolContext } from "../packs.js";
import * as migration001 from "../../db/migrations/001-initial.js";
import * as migration002 from "../../db/migrations/002-fts5-and-embeddings.js";

let db: Kysely<Database>;

beforeEach(async () => {
  const result = createDb<Database>(":memory:");
  db = result.db;
  await migration001.up(db as Kysely<unknown>);
  await migration002.up(db as Kysely<unknown>);
});

afterEach(async () => {
  await db.destroy();
});

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    db,
    chatId: "test-chat",
    apiKey: "test-key",
    projectRoot: "/tmp/test-project",
    dbPath: ":memory:",
    timezone: "UTC",
    tavilyApiKey: "tavily-key",
    isDev: false,
    ...overrides,
  };
}

describe("createAllTools", () => {
  it("returns all built-in tools when all context is available", () => {
    const ctx = makeCtx({
      telegram: {
        bot: {} as any,
        chatId: "123",
        incomingMessageId: 1,
        sideEffects: {},
      },
    });
    const tools = createAllTools(ctx);

    const names = tools.map((t) => t.name);
    expect(names).toContain("memory");
    expect(names).toContain("schedule");
    expect(names).toContain("secret");
    expect(names).toContain("read");
    expect(names).toContain("edit");
    expect(names).toContain("shell");
    expect(names).toContain("web");
    expect(names).toContain("telegram");
  });

  it("excludes web tool when tavilyApiKey is missing", () => {
    const ctx = makeCtx({ tavilyApiKey: undefined });
    const tools = createAllTools(ctx);

    const names = tools.map((t) => t.name);
    expect(names).not.toContain("web");
    expect(names).toContain("memory");
    expect(names).toContain("shell");
  });

  it("excludes telegram tool when no telegram context", () => {
    const ctx = makeCtx({ telegram: undefined });
    const tools = createAllTools(ctx);

    const names = tools.map((t) => t.name);
    expect(names).not.toContain("telegram");
    expect(names).toContain("memory");
  });

  it("includes telegram tool when context is provided", () => {
    const ctx = makeCtx({
      telegram: {
        bot: {} as any,
        chatId: "123",
        incomingMessageId: 1,
        sideEffects: {},
      },
    });
    const tools = createAllTools(ctx);

    const names = tools.map((t) => t.name);
    expect(names).toContain("telegram");
  });

  it("always includes core tools regardless of context", () => {
    const ctx = makeCtx({ tavilyApiKey: undefined, telegram: undefined });
    const tools = createAllTools(ctx);

    const names = tools.map((t) => t.name);
    expect(names).toContain("memory");
    expect(names).toContain("schedule");
    expect(names).toContain("secret");
    expect(names).toContain("read");
    expect(names).toContain("edit");
    expect(names).toContain("shell");
  });
});
