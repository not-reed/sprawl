import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSkillFile,
  checkRequirements,
  loadSoul,
  loadIdentityFiles,
  loadSkills,
} from "../loader.js";

describe("parseSkillFile", () => {
  it("parses valid skill with frontmatter", () => {
    const content = `---
name: daily-standup
description: Guide the user through a daily standup check-in
requires:
  env: []
  secrets: []
---

When the user asks for a standup, guide them through:
1. What did you do yesterday?
2. What are you doing today?
3. Any blockers?`;

    const skill = parseSkillFile(content, "/test/standup.md");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("daily-standup");
    expect(skill!.description).toBe("Guide the user through a daily standup check-in");
    expect(skill!.requires).toEqual({ env: [], secrets: [] });
    expect(skill!.body).toContain("What did you do yesterday?");
    expect(skill!.filePath).toBe("/test/standup.md");
  });

  it("returns null for missing frontmatter", () => {
    const content = "Just some text without frontmatter";
    expect(parseSkillFile(content, "/test/bad.md")).toBeNull();
  });

  it("returns null for missing name", () => {
    const content = `---
description: Has a description but no name
---

Some body text.`;
    expect(parseSkillFile(content, "/test/noname.md")).toBeNull();
  });

  it("returns null for missing description", () => {
    const content = `---
name: nodesc
---

Some body text.`;
    expect(parseSkillFile(content, "/test/nodesc.md")).toBeNull();
  });

  it("defaults requires to empty object", () => {
    const content = `---
name: minimal
description: A minimal skill
---

Body.`;
    const skill = parseSkillFile(content, "/test/minimal.md");
    expect(skill!.requires).toEqual({});
  });
});

describe("checkRequirements", () => {
  it("returns empty array when all requirements met", () => {
    const secrets = new Set(["API_KEY"]);
    process.env.TEST_ENV_VAR = "1";
    const unmet = checkRequirements({ env: ["TEST_ENV_VAR"], secrets: ["API_KEY"] }, secrets);
    expect(unmet).toEqual([]);
    delete process.env.TEST_ENV_VAR;
  });

  it("reports unmet env vars", () => {
    const unmet = checkRequirements({ env: ["NONEXISTENT_VAR"] }, new Set());
    expect(unmet).toEqual(["env: NONEXISTENT_VAR"]);
  });

  it("reports unmet secrets", () => {
    const unmet = checkRequirements({ secrets: ["MISSING_SECRET"] }, new Set(["OTHER_SECRET"]));
    expect(unmet).toEqual(["secret: MISSING_SECRET"]);
  });

  it("returns empty for no requirements", () => {
    const unmet = checkRequirements({}, new Set());
    expect(unmet).toEqual([]);
  });
});

describe("loadSoul", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ext-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("loads SOUL.md when present", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "I am a friendly bot.");
    const soul = await loadSoul(tmpDir);
    expect(soul).toBe("I am a friendly bot.");
  });

  it("returns null when SOUL.md is missing", async () => {
    const soul = await loadSoul(tmpDir);
    expect(soul).toBeNull();
  });

  it("returns null for empty SOUL.md", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "  \n  ");
    const soul = await loadSoul(tmpDir);
    expect(soul).toBeNull();
  });
});

describe("loadIdentityFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ext-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("loads all three files when present", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "I am a friendly bot.");
    await writeFile(join(tmpDir, "IDENTITY.md"), "Name: Construct");
    await writeFile(join(tmpDir, "USER.md"), "Name: Reed");

    const result = await loadIdentityFiles(tmpDir);
    expect(result.soul).toBe("I am a friendly bot.");
    expect(result.identity).toBe("Name: Construct");
    expect(result.user).toBe("Name: Reed");
  });

  it("returns nulls when no files exist", async () => {
    const result = await loadIdentityFiles(tmpDir);
    expect(result.soul).toBeNull();
    expect(result.identity).toBeNull();
    expect(result.user).toBeNull();
  });

  it("handles partial files (only SOUL.md)", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Soul content");

    const result = await loadIdentityFiles(tmpDir);
    expect(result.soul).toBe("Soul content");
    expect(result.identity).toBeNull();
    expect(result.user).toBeNull();
  });

  it("handles partial files (only USER.md)", async () => {
    await writeFile(join(tmpDir, "USER.md"), "User content");

    const result = await loadIdentityFiles(tmpDir);
    expect(result.soul).toBeNull();
    expect(result.identity).toBeNull();
    expect(result.user).toBe("User content");
  });

  it("returns null for empty files", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "  \n  ");
    await writeFile(join(tmpDir, "IDENTITY.md"), "");
    await writeFile(join(tmpDir, "USER.md"), "   ");

    const result = await loadIdentityFiles(tmpDir);
    expect(result.soul).toBeNull();
    expect(result.identity).toBeNull();
    expect(result.user).toBeNull();
  });
});

describe("loadSkills", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ext-test-"));
    await mkdir(join(tmpDir, "skills"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("loads skills from skills/ directory", async () => {
    await writeFile(
      join(tmpDir, "skills", "test.md"),
      `---
name: test-skill
description: A test skill
---

Do the test thing.`,
    );

    const skills = await loadSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("test-skill");
  });

  it("loads nested skills from subdirectories", async () => {
    await mkdir(join(tmpDir, "skills", "coding"), { recursive: true });
    await writeFile(
      join(tmpDir, "skills", "coding", "review.md"),
      `---
name: code-review
description: Review code changes
---

Look at the diff and provide feedback.`,
    );

    const skills = await loadSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("code-review");
  });

  it("returns empty array when skills/ does not exist", async () => {
    await rm(join(tmpDir, "skills"), { recursive: true });
    const skills = await loadSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it("skips invalid skill files", async () => {
    await writeFile(
      join(tmpDir, "skills", "valid.md"),
      `---
name: valid
description: Valid skill
---

Body.`,
    );
    await writeFile(join(tmpDir, "skills", "invalid.md"), "No frontmatter");

    const skills = await loadSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("valid");
  });
});
