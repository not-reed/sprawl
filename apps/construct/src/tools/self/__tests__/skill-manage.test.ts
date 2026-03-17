import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../../db/schema.js";
import {
  createSkillCreateTool,
  createSkillUpdateTool,
  createSkillListTool,
  createSkillInspectTool,
  createSkillDeleteTool,
  createSkillFeedbackTool,
} from "../skill-manage.js";
import { setupDb } from "../../../__tests__/fixtures.js";

// Helper to safely access unknown details
function getDetail<T = unknown>(details: unknown, key: string): T | undefined {
  if (typeof details === "object" && details !== null && key in details) {
    return (details as Record<string, unknown>)[key] as T;
  }
  return undefined;
}

// Mock extractInstructions and resolveDependencyIds
vi.mock("../../../extensions/instructions.js", () => ({
  extractInstructions: vi.fn().mockResolvedValue({
    instructions: ["Step one", "Step two"],
    dependencies: [[1, 0]],
  }),
  resolveDependencyIds: vi.fn().mockImplementation((deps: Array<[number, number]>, ids: string[]) =>
    deps.map(([f, t]: [number, number]) => ({
      fromId: ids[f],
      toId: ids[t],
      relation: "requires",
    })),
  ),
}));

describe("skill_create", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await setupDb();
  });

  it("creates skill row in DB", async () => {
    const tool = createSkillCreateTool(db);

    const result = await tool.execute("test-1", {
      name: "Test Skill",
      description: "A test skill",
      body: "Do this then that",
    });

    expect(result.output).toContain("Created skill");
    expect(getDetail<string>(result.details, "skillId")).toBe("test-skill");

    const skill = await db
      .selectFrom("skills")
      .where("name", "=", "Test Skill")
      .selectAll()
      .executeTakeFirst();

    expect(skill).toBeDefined();
    expect(skill?.status).toBe("active");
    expect(skill?.version).toBe(1);
    expect(skill?.use_count).toBe(0);
  });

  it("extracts instructions when apiKey provided", async () => {
    const tool = createSkillCreateTool(db, "test-api-key", "test-model");

    const result = await tool.execute("test-2", {
      name: "Jellyfin API",
      description: "API methods for Jellyfin",
      body: "Authenticate using Bearer tokens, then fetch user data",
    });

    expect(result.output).toContain("extracted");
    expect(getDetail<number>(result.details, "instructionCount")).toBe(2);

    const instructions = await db
      .selectFrom("skill_instructions")
      .where("skill_id", "=", "jellyfin-api")
      .select(["id", "instruction", "position"])
      .orderBy("position")
      .execute();

    expect(instructions).toHaveLength(2);
    expect(instructions[0]?.instruction).toBe("Step one");
    expect(instructions[1]?.instruction).toBe("Step two");
  });

  it("skips extraction when no apiKey", async () => {
    const tool = createSkillCreateTool(db);

    const result = await tool.execute("test-3", {
      name: "No API Skill",
      description: "No extraction",
      body: "Body",
    });

    expect(result.output).toContain("extension_reload");

    const instructions = await db
      .selectFrom("skill_instructions")
      .select(["id", "skill_id", "instruction", "position", "created_at"])
      .where("skill_id", "=", "no-api-skill")
      .execute();

    expect(instructions).toHaveLength(0);
  });

  it("rejects duplicate skill name", async () => {
    const tool = createSkillCreateTool(db);

    await tool.execute("test-4a", {
      name: "Duplicate",
      description: "First",
      body: "Body 1",
    });

    const result = await tool.execute("test-4b", {
      name: "Duplicate",
      description: "Second",
      body: "Body 2",
    });

    expect(result.output).toContain("already exists");
  });
});

describe("skill_update", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await setupDb();
  });

  it("bumps version on body change", async () => {
    const createTool = createSkillCreateTool(db);
    await createTool.execute("test-5a", {
      name: "Version Test",
      description: "Test versioning",
      body: "Original body",
    });

    const updateTool = createSkillUpdateTool(db);
    const result = await updateTool.execute("test-5b", {
      name: "Version Test",
      body: "Updated body",
    });

    expect(getDetail<number>(result.details, "newVersion")).toBe(2);

    const skill = await db
      .selectFrom("skills")
      .where("id", "=", "version-test")
      .select(["version"])
      .executeTakeFirst();

    expect(skill?.version).toBe(2);
  });

  it("re-extracts instructions when apiKey provided and body changes", async () => {
    const createTool = createSkillCreateTool(db, "test-api-key", "test-model");
    await createTool.execute("test-6a", {
      name: "Update Extract",
      description: "Test re-extraction",
      body: "Original instructions",
    });

    const updateTool = createSkillUpdateTool(db, "test-api-key", "test-model");
    const result = await updateTool.execute("test-6b", {
      name: "Update Extract",
      body: "Updated instructions",
    });

    expect(result.output).toContain("re-extracted");
    expect(getDetail<number>(result.details, "instructionCount")).toBe(2);

    const instructions = await db
      .selectFrom("skill_instructions")
      .select(["id", "skill_id", "instruction", "position", "created_at"])
      .where("skill_id", "=", "update-extract")
      .execute();

    // Old instructions should be deleted, new ones inserted
    expect(instructions).toHaveLength(2);
  });

  it("skips re-extraction when only description changed", async () => {
    const createTool = createSkillCreateTool(db);
    await createTool.execute("test-7a", {
      name: "Desc Only",
      description: "Original description",
      body: "Body stays same",
    });

    const updateTool = createSkillUpdateTool(db, "test-api-key", "test-model");
    const result = await updateTool.execute("test-7b", {
      name: "Desc Only",
      description: "Updated description only",
    });

    expect(result.output).toContain("Updated skill");
    expect(result.output).not.toContain("re-extracted");
  });

  it("returns not found for unknown skill", async () => {
    const updateTool = createSkillUpdateTool(db, "test-api-key", "test-model");
    const result = await updateTool.execute("test-8", {
      name: "Nonexistent Skill",
      body: "Body",
    });

    expect(result.output).toContain("not found");
  });
});

describe("skill_list", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await setupDb();
  });

  it("returns empty when no skills", async () => {
    const tool = createSkillListTool(db);
    const result = await tool.execute("test-9", {});

    expect(result.output).toContain("No active skills");
  });

  it("lists active skills with use_count", async () => {
    const createTool = createSkillCreateTool(db);
    await createTool.execute("test-10a", {
      name: "Skill A",
      description: "First skill",
      body: "Body A",
    });
    await createTool.execute("test-10b", {
      name: "Skill B",
      description: "Second skill",
      body: "Body B",
    });

    const tool = createSkillListTool(db);
    const result = await tool.execute("test-10c", {});

    expect(getDetail<number>(result.details, "count")).toBe(2);
    const skills = getDetail<Array<{ name: string }> | undefined>(result.details, "skills");
    expect(skills).toHaveLength(2);
    expect(skills?.[0]?.name).toBe("Skill A");
    expect(skills?.[1]?.name).toBe("Skill B");
  });

  it("excludes deprecated skills", async () => {
    const createTool = createSkillCreateTool(db);
    await createTool.execute("test-11a", {
      name: "Skill C",
      description: "Will be deprecated",
      body: "Body C",
    });

    const deleteTool = createSkillDeleteTool(db);
    await deleteTool.execute("test-11b", { name: "Skill C" });

    const tool = createSkillListTool(db);
    const result = await tool.execute("test-11c", {});

    expect(result.output).toContain("No active skills");
  });
});

describe("skill_inspect", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await setupDb();
  });

  it("returns not found for unknown skill", async () => {
    const tool = createSkillInspectTool(db);
    const result = await tool.execute("test-12", { name: "Unknown Skill" });

    expect(result.output).toContain("not found");
  });

  it("returns skill with instructions + executions", async () => {
    const createTool = createSkillCreateTool(db, "test-api-key", "test-model");
    await createTool.execute("test-13a", {
      name: "Inspect Test",
      description: "A skill to inspect",
      body: "Instructions here",
    });

    // Add an execution
    const feedbackTool = createSkillFeedbackTool(db);
    await feedbackTool.execute("test-13b", {
      name: "Inspect Test",
      success: true,
      notes: "Worked great",
    });

    const tool = createSkillInspectTool(db);
    const result = await tool.execute("test-13c", { name: "Inspect Test" });

    expect(result.output).toContain("Inspect Test");
    expect(result.output).toContain("Instructions");
    expect(result.output).toContain("executions");

    const skill = getDetail<{ name: string } | undefined>(result.details, "skill");
    expect(skill?.name).toBe("Inspect Test");

    const instructions = getDetail<Array<{ position: number }> | undefined>(
      result.details,
      "instructions",
    );
    expect(instructions).toHaveLength(2);

    const executions = getDetail<Array<{ success: number }> | undefined>(
      result.details,
      "executions",
    );
    expect(executions).toHaveLength(1);
  });

  it("shows instructions in position order", async () => {
    const createTool = createSkillCreateTool(db, "test-api-key", "test-model");
    await createTool.execute("test-14", {
      name: "Order Test",
      description: "Test instruction order",
      body: "Multi-step process",
    });

    const tool = createSkillInspectTool(db);
    const result = await tool.execute("test-14b", { name: "Order Test" });

    const instructions = getDetail<Array<{ position: number }> | undefined>(
      result.details,
      "instructions",
    );
    const instrs = instructions || [];
    for (let i = 0; i < instrs.length; i++) {
      expect(instrs[i]?.position).toBe(i);
    }
  });
});

describe("skill_delete", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await setupDb();
  });

  it("sets status to deprecated", async () => {
    const createTool = createSkillCreateTool(db);
    await createTool.execute("test-15a", {
      name: "To Delete",
      description: "Will be deleted",
      body: "Body",
    });

    const deleteTool = createSkillDeleteTool(db);
    await deleteTool.execute("test-15b", { name: "To Delete" });

    const skill = await db
      .selectFrom("skills")
      .where("id", "=", "to-delete")
      .select(["status"])
      .executeTakeFirst();

    expect(skill?.status).toBe("deprecated");
  });

  it("is idempotent", async () => {
    const createTool = createSkillCreateTool(db);
    await createTool.execute("test-16a", {
      name: "Idempotent",
      description: "Test idempotency",
      body: "Body",
    });

    const deleteTool = createSkillDeleteTool(db);
    await deleteTool.execute("test-16b", { name: "Idempotent" });
    const result2 = await deleteTool.execute("test-16c", { name: "Idempotent" });

    expect(result2.output).toContain("Deprecated");

    const skill = await db
      .selectFrom("skills")
      .where("id", "=", "idempotent")
      .select(["status"])
      .executeTakeFirst();

    expect(skill?.status).toBe("deprecated");
  });
});

describe("skill_feedback", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await setupDb();
  });

  it("inserts execution record with correct success flag", async () => {
    const createTool = createSkillCreateTool(db);
    await createTool.execute("test-17a", {
      name: "Feedback Test",
      description: "Test feedback",
      body: "Body",
    });

    const feedbackTool = createSkillFeedbackTool(db);
    const result = await feedbackTool.execute("test-17b", {
      name: "Feedback Test",
      success: true,
      notes: "Worked perfectly",
      conversation_id: "conv-123",
    });

    expect(getDetail<string>(result.details, "executionId")).toBeDefined();

    const execution = await db
      .selectFrom("skill_executions")
      .where("skill_id", "=", "feedback-test")
      .selectAll()
      .executeTakeFirst();

    expect(execution?.success).toBe(1);
    expect(execution?.feedback_notes).toBe("Worked perfectly");
    expect(execution?.conversation_id).toBe("conv-123");
  });

  it("returns not found for unknown skill", async () => {
    const tool = createSkillFeedbackTool(db);
    const result = await tool.execute("test-18", {
      name: "Nonexistent",
      success: true,
    });

    expect(result.output).toContain("not found");
  });
});
