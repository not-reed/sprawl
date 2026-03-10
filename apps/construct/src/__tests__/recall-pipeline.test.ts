/**
 * Pipeline tests for recallMemories() — embedding recall, FTS+embedding dedup,
 * threshold filtering, combined ranking, and category filtering.
 *
 * Uses synthetic 16-d embeddings. No API key needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { recallMemories, cosineSimilarity } from "@repo/cairn";
import { setupDb, seedMemories, queryEmbeddings, memoryEmbeddings } from "./fixtures.js";

let db: Kysely<Database>;
let memIds: Record<string, string>;

beforeEach(async () => {
  db = await setupDb();
  const seeded = await seedMemories(db);
  memIds = seeded.ids;
});

afterEach(async () => {
  await db.destroy();
});

describe("recallMemories — embedding recall", () => {
  it("finds semantically related memories via embedding similarity", async () => {
    // "food allergies" query → should find shellfish allergy via embedding, not keyword
    const results = await recallMemories(db, "what are my food restrictions", {
      queryEmbedding: queryEmbeddings.foodAllergies,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(memIds.shellfish);

    // Verify it was found via embedding, not keyword (query has no matching keywords)
    const shellfish = results.find((r) => r.id === memIds.shellfish);
    expect(shellfish?.matchType).toBe("embedding");
    expect(shellfish?.score).toBeGreaterThan(0.9);
  });

  it("pet query returns cat memory with high score", async () => {
    const results = await recallMemories(db, "furry friends", {
      queryEmbedding: queryEmbeddings.pet,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(memIds.miso);

    // Should NOT contain unrelated memories (work, health)
    expect(ids).not.toContain(memIds.datapipe);
    expect(ids).not.toContain(memIds.shellfish);
  });

  it("work query returns both work-category memories", async () => {
    const results = await recallMemories(db, "engineering job", {
      queryEmbedding: queryEmbeddings.work,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(memIds.datapipe);
    expect(ids).toContain(memIds.clickstream);

    // darkMode has a work component — verify it also matches
    expect(ids).toContain(memIds.darkMode);
  });
});

describe("recallMemories — FTS + embedding dedup", () => {
  it("returns a memory once even when both FTS and embedding match", async () => {
    // "shellfish" keyword → FTS match, plus health embedding → embedding match
    const results = await recallMemories(db, "shellfish", {
      queryEmbedding: queryEmbeddings.foodAllergies,
    });

    const shellfish = results.filter((r) => r.id === memIds.shellfish);
    expect(shellfish).toHaveLength(1);

    // FTS should have found it first
    expect(shellfish[0].matchType).toBe("fts5");
  });

  it("FTS results come before embedding-only results", async () => {
    // "Rust" is a keyword match AND has embedding similarity to hobbies
    const results = await recallMemories(db, "Rust", {
      queryEmbedding: queryEmbeddings.hobbies,
    });

    // Rust memory should be found via FTS first
    const rustIdx = results.findIndex((r) => r.id === memIds.rust);
    expect(rustIdx).toBeGreaterThanOrEqual(0);
    expect(results[rustIdx].matchType).toBe("fts5");

    // Any embedding-only results should come after FTS results
    const ftsResults = results.filter((r) => r.matchType === "fts5");
    const embeddingResults = results.filter((r) => r.matchType === "embedding");
    if (embeddingResults.length > 0) {
      const lastFtsIdx = results.findIndex((r) => r.id === ftsResults[ftsResults.length - 1].id);
      const firstEmbIdx = results.findIndex((r) => r.id === embeddingResults[0].id);
      expect(firstEmbIdx).toBeGreaterThan(lastFtsIdx);
    }
  });
});

describe("recallMemories — threshold filtering", () => {
  it("returns nothing when query embedding is orthogonal to all memories", async () => {
    // orthogonal query (dim 15) has zero similarity with all memory embeddings
    const results = await recallMemories(db, "xyzzy_no_keyword_match_here", {
      queryEmbedding: queryEmbeddings.orthogonal,
    });

    // No FTS match (gibberish query), no embedding match (orthogonal), no LIKE match
    expect(results).toHaveLength(0);
  });

  it("respects custom similarity threshold", async () => {
    // With a very high threshold, even similar embeddings should be filtered out
    const results = await recallMemories(db, "xyzzy_no_match", {
      queryEmbedding: queryEmbeddings.work,
      similarityThreshold: 0.99,
    });

    // datapipe embedding has cosine ~0.995 with work query, so it might pass
    // but clickstream (0.9 work + 0.2 hobby) will be slightly under 0.99
    // The exact threshold behavior depends on normalized vectors
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.99);
    }
  });
});

describe("recallMemories — category filtering", () => {
  it("filters to work category even when other embeddings score higher", async () => {
    // hobbies query would normally match rust (learning) and darkMode (preference)
    // but with category=work, only work memories should return
    const results = await recallMemories(db, "engineering", {
      queryEmbedding: queryEmbeddings.work,
      category: "work",
    });

    for (const r of results) {
      expect(r.category).toBe("work");
    }

    const ids = results.map((r) => r.id);
    expect(ids).toContain(memIds.datapipe);
    expect(ids).toContain(memIds.clickstream);
    // Not personal/learning even if they have work-like embeddings
    expect(ids).not.toContain(memIds.rust);
    expect(ids).not.toContain(memIds.darkMode);
  });

  it("returns empty when category has no matches", async () => {
    const results = await recallMemories(db, "xyzzy", {
      queryEmbedding: queryEmbeddings.pet,
      category: "nonexistent",
    });

    expect(results).toHaveLength(0);
  });
});

describe("synthetic embedding sanity checks", () => {
  it("same-cluster vectors have high cosine similarity", () => {
    // Pet query vs cat memory embedding
    const sim = cosineSimilarity(queryEmbeddings.pet, memoryEmbeddings.miso);
    expect(sim).toBeGreaterThan(0.9);
  });

  it("cross-cluster vectors have near-zero cosine similarity", () => {
    // Pet query vs work memory embedding
    const sim = cosineSimilarity(queryEmbeddings.pet, memoryEmbeddings.datapipe);
    expect(sim).toBeCloseTo(0, 1);
  });

  it("orthogonal query has zero similarity with all memories", () => {
    for (const [, emb] of Object.entries(memoryEmbeddings)) {
      const sim = cosineSimilarity(queryEmbeddings.orthogonal, emb);
      expect(sim).toBeCloseTo(0, 5);
    }
  });

  it("blended embeddings have partial similarity with both clusters", () => {
    // darkMode is 50/50 work+hobby → should have ~0.7 similarity with both
    const workSim = cosineSimilarity(queryEmbeddings.work, memoryEmbeddings.darkMode);
    const hobbySim = cosineSimilarity(queryEmbeddings.hobbies, memoryEmbeddings.darkMode);
    expect(workSim).toBeGreaterThan(0.6);
    expect(hobbySim).toBeGreaterThan(0.6);
    expect(workSim).toBeLessThan(0.8);
    expect(hobbySim).toBeLessThan(0.8);
  });
});
