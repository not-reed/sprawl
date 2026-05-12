import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { createScheduleTool } from "../core/schedule.js";
import { createSecretTool } from "../core/secret.js";
import { createReadTool } from "../core/read.js";
import { createEditTool } from "../core/edit.js";
import { createShellTool } from "../core/shell.js";
import { createWebTool } from "../web/web.js";
import { createTelegramTool } from "../telegram/telegram.js";
import type { TelegramContext } from "../../telegram/types.js";
import { setupDb } from "../../__tests__/fixtures.js";

let db: Kysely<Database>;

beforeEach(async () => {
  db = await setupDb();
});

afterEach(async () => {
  await db.destroy();
});

// --- Schedule ---

describe("schedule tool", () => {
  it("creates a schedule with action=create", async () => {
    const tool = createScheduleTool(db, "test-chat", "UTC", "test-key");
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 19);
    const result = await tool.execute("t1", {
      action: "create",
      description: "Test reminder",
      instruction: "Tell the user about the test",
      run_at: tomorrow,
    });
    expect(result.output).toContain("Created");
    expect(result.output).toContain("Test reminder");
  });

  it("lists schedules with action=list", async () => {
    const tool = createScheduleTool(db, "test-chat", "UTC", "test-key");
    const result = await tool.execute("t1", { action: "list" });
    expect(result.output).toContain("scheduled reminders");
  });

  it("cancels a schedule with action=cancel", async () => {
    const tool = createScheduleTool(db, "test-chat", "UTC", "test-key");
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 19);
    const createResult = await tool.execute("t1", {
      action: "create",
      description: "Cancel me",
      instruction: "Tell the user",
      run_at: tomorrow,
    });
    const id = (createResult.details as any).schedule.id;

    const result = await tool.execute("t2", { action: "cancel", id });
    expect(result.output).toContain("Cancelled");
  });

  it("requires description and instruction for create", async () => {
    const tool = createScheduleTool(db, "test-chat", "UTC", "test-key");
    const result = await tool.execute("t1", { action: "create" });
    expect(result.output).toContain("requires");
  });
});

// --- Secret ---

describe("secret tool", () => {
  it("stores a secret with action=store", async () => {
    const tool = createSecretTool(db);
    const result = await tool.execute("t1", {
      action: "store",
      key: "API_KEY",
      value: "sk-test-123",
    });
    expect(result.output).toContain("API_KEY");
    expect(result.output).toContain("stored");
  });

  it("lists secrets with action=list", async () => {
    const tool = createSecretTool(db);
    await tool.execute("t1", { action: "store", key: "MY_KEY", value: "secret123" });

    const result = await tool.execute("t2", { action: "list" });
    expect(result.output).toContain("1 secret");
    expect(result.output).toContain("MY_KEY");
    expect(result.output).not.toContain("secret123");
  });

  it("deletes a secret with action=delete", async () => {
    const tool = createSecretTool(db);
    await tool.execute("t1", { action: "store", key: "TO_DELETE", value: "gone" });

    const result = await tool.execute("t2", { action: "delete", key: "TO_DELETE" });
    expect(result.output).toContain("deleted");
  });

  it("returns not found for nonexistent delete", async () => {
    const tool = createSecretTool(db);
    const result = await tool.execute("t1", { action: "delete", key: "NOPE" });
    expect(result.output).toContain("not found");
  });
});

// --- Telegram ---

describe("telegram tool", () => {
  function mockBot() {
    return {
      api: {
        pinChatMessage: vi.fn().mockResolvedValue({}),
        unpinChatMessage: vi.fn().mockResolvedValue({}),
        unpinAllChatMessages: vi.fn().mockResolvedValue({}),
        getChat: vi.fn().mockResolvedValue({}),
      },
    } as any;
  }

  function mockTelegram(bot?: any, chatId = "123456"): TelegramContext {
    return {
      bot: bot ?? mockBot(),
      chatId,
      incomingMessageId: 42,
      sideEffects: {},
    };
  }

  it("reacts with action=react", async () => {
    const ctx = mockTelegram();
    const tool = createTelegramTool(db, ctx);
    const result = await tool.execute("t1", { action: "react", emoji: "👍" });
    expect(result.output).toContain("👍");
    expect(ctx.sideEffects.reactToUser).toBe("👍");
  });

  it("replies with action=reply", async () => {
    const ctx = mockTelegram();
    const tool = createTelegramTool(db, ctx);
    const result = await tool.execute("t1", { action: "reply", telegram_message_id: 123 });
    expect(result.output).toContain("123");
    expect(ctx.sideEffects.replyToMessageId).toBe(123);
  });

  it("pins with action=pin", async () => {
    const bot = mockBot();
    const ctx = mockTelegram(bot);
    const tool = createTelegramTool(db, ctx);
    const result = await tool.execute("t1", { action: "pin", telegram_message_id: 555 });
    expect(result.output).toContain("555");
    expect(bot.api.pinChatMessage).toHaveBeenCalledWith("123456", 555, {
      disable_notification: true,
    });
  });

  it("unpins with action=unpin", async () => {
    const bot = mockBot();
    const ctx = mockTelegram(bot);
    const tool = createTelegramTool(db, ctx);
    const result = await tool.execute("t1", { action: "unpin" });
    expect(result.output).toContain("Unpinned all");
    expect(bot.api.unpinAllChatMessages).toHaveBeenCalledWith("123456");
  });

  it("asks with action=ask", async () => {
    const ctx = mockTelegram();
    const tool = createTelegramTool(db, ctx);
    const result = await tool.execute("t1", {
      action: "ask",
      question: "Deploy now?",
      options: ["Yes", "No"],
    });
    expect(result.output).toContain("Question sent");
    expect(ctx.sideEffects.askPayload).toBeDefined();
    expect(ctx.sideEffects.askPayload!.question).toBe("Deploy now?");
  });

  it("rejects invalid emoji", async () => {
    const ctx = mockTelegram();
    const tool = createTelegramTool(db, ctx);
    const result = await tool.execute("t1", { action: "react", emoji: "🚫INVALID" });
    expect(result.output).toContain("Invalid");
  });

  it("gets pinned message with action=get_pinned", async () => {
    const bot = mockBot();
    bot.api.getChat = vi.fn().mockResolvedValue({
      pinned_message: { message_id: 789, text: "Important" },
    });
    const ctx = mockTelegram(bot);
    const tool = createTelegramTool(db, ctx);
    const result = await tool.execute("t1", { action: "get_pinned" });
    expect(result.output).toContain("789");
    expect(result.output).toContain("Important");
  });
});

// --- Read ---

describe("read tool", () => {
  it("reads identity file with action=identity", async () => {
    const tool = createReadTool("/tmp/test-project", "/tmp/test-extensions");
    const result = await tool.execute("t1", { action: "identity", file: "SOUL.md" });
    // SOUL.md doesn't exist in test, so we should get the "does not exist" message
    expect(result.output).toContain("does not exist");
  });

  it("returns error for missing path on file action", async () => {
    const tool = createReadTool("/tmp/test-project");
    const result = await tool.execute("t1", { action: "file" });
    expect(result.output).toContain("requires");
  });

  it("blocks .env files", async () => {
    const tool = createReadTool("/tmp/test-project");
    const result = await tool.execute("t1", {
      action: "file",
      path: "apps/construct/.env.construct",
    });
    expect(result.output).toContain("Access denied");
    expect(result.output).toContain("blocked path pattern");
  });

  it("blocks node_modules", async () => {
    const tool = createReadTool("/tmp/test-project");
    const result = await tool.execute("t1", { action: "file", path: "node_modules/foo/index.js" });
    expect(result.output).toContain("Access denied");
  });
});

// --- Edit ---

describe("edit tool", () => {
  it("returns error for missing params on source action", async () => {
    const tool = createEditTool("/tmp/test-project");
    const result = await tool.execute("t1", { action: "source" });
    expect(result.output).toContain("requires");
  });

  it("returns scope violation for invalid path", async () => {
    const tool = createEditTool("/tmp/test-project");
    const result = await tool.execute("t1", {
      action: "source",
      path: "/etc/passwd",
      search: "test",
      replace: "test",
    });
    expect(result.output).toContain("Access denied");
  });

  it("blocks .env files", async () => {
    const tool = createEditTool("/tmp/test-project");
    const result = await tool.execute("t1", {
      action: "source",
      path: "apps/construct/.env.construct",
      search: "x",
      replace: "y",
    });
    expect(result.output).toContain("Access denied");
    expect(result.output).toContain("blocked path pattern");
  });
});

// --- Shell ---

describe("shell tool (unchanged)", () => {
  it("runs a simple command", async () => {
    const tool = createShellTool("/tmp");
    const result = await tool.execute("t1", { command: "echo hello" });
    expect(result.output).toContain("hello");
    expect((result.details as any).exit_code).toBe(0);
  });
});

// --- Web ---

describe("web tool", () => {
  it("returns error for missing query on search action", async () => {
    const tool = createWebTool("fake-api-key");
    const result = await tool.execute("t1", { action: "search" });
    expect(result.output).toContain("requires");
  });

  it("returns error for missing url on read action", async () => {
    const tool = createWebTool("fake-api-key");
    const result = await tool.execute("t1", { action: "read" });
    expect(result.output).toContain("requires");
  });
});
