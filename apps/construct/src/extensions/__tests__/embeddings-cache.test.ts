import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { setupDb } from "../../__tests__/fixtures.js";
import {
  loadCachedEmbeddings,
  computeMissingEmbeddings,
  clearExtensionEmbeddings,
  selectSkills,
  selectSkillInstructions,
} from "../embeddings.js";
import type { Skill } from "../types.js";

// Mock generateEmbedding to avoid API calls
vi.mock("@repo/cairn", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    generateEmbedding: vi.fn(async (_apiKey: string, text: string) => {
      // Deterministic 4-d embedding based on text hash
      const hash = Array.from(text).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
      const v = [Math.sin(hash), Math.cos(hash), Math.sin(hash * 2), Math.cos(hash * 2)];
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return v.map((x) => x / norm);
    }),
  };
});

/** Serialize embedding to Buffer (same logic as embeddings.ts) */
function embeddingToBuffer(embedding: number[]): Buffer {
  return Buffer.from(new Float64Array(embedding).buffer);
}

function bufferToEmbedding(buf: Buffer): number[] {
  return Array.from(new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8));
}

const testSkills: Skill[] = [
  {
    name: "cooking",
    description: "Help with recipes and cooking techniques",
    requires: {},
    body: "Guide through cooking steps.",
    filePath: "/test/cooking.md",
  },
  {
    name: "fitness",
    description: "Plan workout routines",
    requires: {},
    body: "Create balanced exercise plans.",
    filePath: "/test/fitness.md",
  },
];

async function seedSkillsAndInstructions(db: Kysely<Database>) {
  // Insert skills
  for (const skill of testSkills) {
    const id = skill.name.toLowerCase().replace(/\s+/g, "-");
    await db
      .insertInto("skills")
      .values({
        id,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        version: 1,
        parent_id: null,
        status: "active",
        use_count: 0,
      })
      .execute();

    // Insert instruction
    await db
      .insertInto("skill_instructions")
      .values({
        id: `instr-${id}`,
        skill_id: id,
        instruction: skill.body,
        position: 0,
      })
      .execute();
  }
}

describe("embedding cache", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    clearExtensionEmbeddings();
    db = await setupDb();
  });

  describe("embeddingToBuffer / bufferToEmbedding roundtrip", () => {
    it("preserves embedding values through serialization", () => {
      const original = [0.1, -0.25, 0.333, 1.0, -1.0, 0.0, Number.EPSILON];
      const buf = embeddingToBuffer(original);
      const restored = bufferToEmbedding(buf);

      expect(restored).toHaveLength(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBe(original[i]);
      }
    });

    it("handles empty embedding", () => {
      const buf = embeddingToBuffer([]);
      const restored = bufferToEmbedding(buf);
      expect(restored).toEqual([]);
    });

    it("produces correct buffer size (8 bytes per float64)", () => {
      const emb = [1.0, 2.0, 3.0];
      const buf = embeddingToBuffer(emb);
      expect(buf.byteLength).toBe(3 * 8);
    });
  });

  describe("loadCachedEmbeddings", () => {
    it("loads skill embeddings from DB", async () => {
      await seedSkillsAndInstructions(db);

      // Pre-populate embedding in DB for one skill
      const emb = [0.5, 0.5, 0.5, 0.5];
      await db
        .updateTable("skills")
        .set({ embedding: embeddingToBuffer(emb) })
        .where("id", "=", "cooking")
        .execute();

      await loadCachedEmbeddings(db);

      // selectSkills uses the internal skillEmbeddings map
      // If cooking has an embedding, it should be scoreable
      const result = selectSkills(emb, testSkills, 0.0);
      expect(result.some((s) => s.name === "cooking")).toBe(true);
    });

    it("loads instruction embeddings from DB", async () => {
      await seedSkillsAndInstructions(db);

      // Pre-populate embedding for instruction
      const emb = [0.5, 0.5, 0.5, 0.5];
      await db
        .updateTable("skill_instructions")
        .set({ embedding: embeddingToBuffer(emb) })
        .where("id", "=", "instr-cooking")
        .execute();

      await loadCachedEmbeddings(db);

      // selectSkillInstructions uses the internal instructionEmbeddings map
      const result = await selectSkillInstructions(emb, 0.0);
      expect(result.length).toBeGreaterThan(0);
      expect(result.some((i) => i.id === "instr-cooking")).toBe(true);
    });

    it("returns empty caches when no embeddings in DB", async () => {
      await seedSkillsAndInstructions(db);
      await loadCachedEmbeddings(db);

      // No embeddings set → skill selection returns nothing
      const result = selectSkills([1, 0, 0, 0], testSkills, 0.3);
      expect(result).toEqual([]);
    });

    it("skips inactive skills", async () => {
      await seedSkillsAndInstructions(db);

      const emb = [0.5, 0.5, 0.5, 0.5];
      await db
        .updateTable("skills")
        .set({ embedding: embeddingToBuffer(emb), status: "inactive" })
        .where("id", "=", "cooking")
        .execute();

      await loadCachedEmbeddings(db);

      // threshold > 0 so skills without cached embeddings (score 0) are excluded
      const result = selectSkills(emb, testSkills, 0.1);
      expect(result.some((s) => s.name === "cooking")).toBe(false);
    });
  });

  describe("computeMissingEmbeddings", () => {
    it("computes and persists embeddings for skills without cached embeddings", async () => {
      await seedSkillsAndInstructions(db);
      await loadCachedEmbeddings(db);

      // No embeddings yet → should compute for all skills + instructions
      await computeMissingEmbeddings(db, "test-key", testSkills);

      // Verify DB was updated
      const skillRow = await db
        .selectFrom("skills")
        .where("id", "=", "cooking")
        .select("embedding")
        .executeTakeFirstOrThrow();
      expect(skillRow.embedding).not.toBeNull();

      const instrRow = await db
        .selectFrom("skill_instructions")
        .where("id", "=", "instr-cooking")
        .select("embedding")
        .executeTakeFirstOrThrow();
      expect(instrRow.embedding).not.toBeNull();
    });

    it("skips skills that already have cached embeddings", async () => {
      await seedSkillsAndInstructions(db);

      // Pre-cache cooking skill embedding AND its instruction embedding
      const preEmb = [0.1, 0.2, 0.3, 0.4];
      await db
        .updateTable("skills")
        .set({ embedding: embeddingToBuffer(preEmb) })
        .where("id", "=", "cooking")
        .execute();
      await db
        .updateTable("skill_instructions")
        .set({ embedding: embeddingToBuffer(preEmb) })
        .where("id", "=", "instr-cooking")
        .execute();

      await loadCachedEmbeddings(db);

      // Compute missing — should only compute for fitness skill + instruction, not cooking
      const { generateEmbedding } = await import("@repo/cairn");
      const mockFn = generateEmbedding as ReturnType<typeof vi.fn>;
      mockFn.mockClear();

      await computeMissingEmbeddings(db, "test-key", testSkills);

      // Check that generateEmbedding was NOT called for any cooking-related text
      const calls = mockFn.mock.calls.map((c: unknown[]) => c[1] as string);
      const cookingCalls = calls.filter((t: string) => t.toLowerCase().includes("cooking"));
      expect(cookingCalls).toHaveLength(0);
      // But WAS called for fitness
      expect(calls.some((t: string) => t.includes("fitness"))).toBe(true);
    });

    it("persisted embeddings survive reload", async () => {
      await seedSkillsAndInstructions(db);
      await loadCachedEmbeddings(db);

      // Compute all
      await computeMissingEmbeddings(db, "test-key", testSkills);

      // Clear in-memory caches (simulating restart)
      clearExtensionEmbeddings();

      // Reload from DB
      await loadCachedEmbeddings(db);

      // Should have embeddings from DB without any API calls
      const { generateEmbedding } = await import("@repo/cairn");
      const mockFn = generateEmbedding as ReturnType<typeof vi.fn>;
      mockFn.mockClear();

      await computeMissingEmbeddings(db, "test-key", testSkills);

      // No API calls needed — all cached
      expect(mockFn).not.toHaveBeenCalled();
    });
  });
});
