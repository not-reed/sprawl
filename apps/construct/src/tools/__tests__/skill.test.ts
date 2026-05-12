import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { createSkillTool } from "../self/skill.js";
import { setupDb } from "../../__tests__/fixtures.js";

let db: Kysely<Database>;

beforeEach(async () => {
  db = await setupDb();
});

afterEach(async () => {
  await db.destroy();
});

async function makeSkill(tool: ReturnType<typeof createSkillTool>, name: string) {
  return tool.execute("t1", {
    action: "create",
    name,
    description: "d",
    body: "b",
  });
}

describe("skill tool - create", () => {
  it("creates a skill with action=create", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", {
      action: "create",
      name: "Jellyfin API",
      description: "How to use Jellyfin",
      body: "1. Authenticate with API key\n2. GET /Users/{id}/Items",
    });
    expect(result.output).toContain("Created skill");
    expect(result.output).toContain("Jellyfin API");
    expect((result.details as any).skillId).toBe("jellyfin-api");
  });

  it("rejects duplicate skill creation", async () => {
    const tool = createSkillTool(db);
    await tool.execute("t1", {
      action: "create",
      name: "Dup Skill",
      description: "test",
      body: "test body",
    });
    const result = await tool.execute("t2", {
      action: "create",
      name: "Dup Skill",
      description: "test",
      body: "different body",
    });
    expect(result.output).toContain("already exists");
  });

  it("rejects skill name that collides on normalized ID", async () => {
    const tool = createSkillTool(db);
    await tool.execute("t1", {
      action: "create",
      name: "foo bar",
      description: "first",
      body: "body1",
    });
    const result = await tool.execute("t2", {
      action: "create",
      name: "foo-bar",
      description: "second",
      body: "body2",
    });
    expect(result.output).toContain("collision");
    expect((result.details as any).error).toBe("id_collision");
  });

  it("requires name/description/body for create", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", { action: "create" });
    expect(result.output).toContain("requires");
  });
});

describe("skill tool - list", () => {
  it("lists skills with action=list", async () => {
    const tool = createSkillTool(db);
    await makeSkill(tool, "Test Skill");
    const result = await tool.execute("t2", { action: "list" });
    expect(result.output).toContain("Test Skill");
  });

  it("returns empty list when no skills", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", { action: "list" });
    expect(result.output).toContain("No active skills");
  });
});

describe("skill tool - inspect", () => {
  it("inspects a skill with action=inspect", async () => {
    const tool = createSkillTool(db);
    await tool.execute("t1", {
      action: "create",
      name: "Inspect Me",
      description: "Inspectable",
      body: "Step 1",
    });
    const result = await tool.execute("t2", { action: "inspect", name: "Inspect Me" });
    expect(result.output).toContain("Inspect Me");
    expect(result.output).toContain("Version: 1");
  });

  it("returns not found for inspecting nonexistent skill", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", { action: "inspect", name: "Nope" });
    expect(result.output).toContain("not found");
  });

  it("inspect requires a name parameter", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", { action: "inspect" });
    expect(result.output).toContain("requires");
  });
});

describe("skill tool - delete", () => {
  it("deletes a skill with action=delete", async () => {
    const tool = createSkillTool(db);
    await makeSkill(tool, "Delete Me");
    const result = await tool.execute("t2", { action: "delete", name: "Delete Me" });
    expect(result.output).toContain("Deprecated");

    const list = await tool.execute("t3", { action: "list" });
    expect(list.output).toContain("No active skills");
  });

  it("delete requires a name parameter", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", { action: "delete" });
    expect(result.output).toContain("requires");
  });
});

describe("skill tool - feedback", () => {
  it("records feedback with action=feedback", async () => {
    const tool = createSkillTool(db);
    await makeSkill(tool, "Feedback Skill");
    const result = await tool.execute("t2", {
      action: "feedback",
      name: "Feedback Skill",
      success: true,
      notes: "Worked well",
    });
    expect(result.output).toContain("success");
    expect(result.output).toContain("Worked well");
  });

  it("requires name and success for feedback", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", { action: "feedback" });
    expect(result.output).toContain("requires");
  });

  it("records failure feedback with success=false", async () => {
    const tool = createSkillTool(db);
    await makeSkill(tool, "Fail Skill");
    const result = await tool.execute("t2", {
      action: "feedback",
      name: "Fail Skill",
      success: false,
    });
    expect(result.output).toContain("failure");
  });

  it("feedback returns not found for missing skill", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", {
      action: "feedback",
      name: "Phantom",
      success: true,
    });
    expect(result.output).toContain("not found");
  });
});

describe("skill tool - update", () => {
  it("updates a skill description with action=update", async () => {
    const tool = createSkillTool(db);
    await tool.execute("t1", {
      action: "create",
      name: "Update Me",
      description: "original",
      body: "step 1",
    });
    const result = await tool.execute("t2", {
      action: "update",
      name: "Update Me",
      description: "revised",
    });
    expect(result.output).toContain("v2");
    expect((result.details as any).newVersion).toBe(2);
  });

  it("updates skill body without apiKey notes the missing extraction", async () => {
    const tool = createSkillTool(db);
    await tool.execute("t1", {
      action: "create",
      name: "Body Update",
      description: "d",
      body: "old body",
    });
    const result = await tool.execute("t2", {
      action: "update",
      name: "Body Update",
      body: "new body",
    });
    expect(result.output).toContain("v2");
    expect(result.output).toContain("No API key");
  });

  it("update returns not found for missing skill", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", {
      action: "update",
      name: "Ghost",
      description: "x",
    });
    expect(result.output).toContain("not found");
  });

  it("update requires a name parameter", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", { action: "update", description: "x" });
    expect(result.output).toContain("requires");
  });
});

describe("skill tool - other", () => {
  it("rejects conflicts action without api key", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", { action: "conflicts" });
    expect(result.output).toContain("API key");
  });

  it("returns error for unknown skill action", async () => {
    const tool = createSkillTool(db);
    const result = await tool.execute("t1", { action: "bogus" } as any);
    expect(result.output).toContain("Unknown action");
  });
});
