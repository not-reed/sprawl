import { describe, it, expect } from "vitest";
import { selectSkills } from "../embeddings.js";
import type { Skill } from "../types.js";

// Synthetic skills for testing
const skills: Skill[] = [
  {
    name: "standup",
    description: "Guide through daily standup",
    requires: {},
    body: "Ask about yesterday, today, blockers.",
    filePath: "/test/standup.md",
  },
  {
    name: "haiku",
    description: "Help write haikus",
    requires: {},
    body: "Write a 5-7-5 syllable poem.",
    filePath: "/test/haiku.md",
  },
  {
    name: "workout",
    description: "Plan a workout routine",
    requires: {},
    body: "Create a balanced exercise plan.",
    filePath: "/test/workout.md",
  },
];

describe("selectSkills", () => {
  it("returns empty when no query embedding", () => {
    const result = selectSkills(undefined, skills);
    expect(result).toEqual([]);
  });

  it("returns empty when no skills", () => {
    const result = selectSkills([1, 0, 0], []);
    expect(result).toEqual([]);
  });

  it("returns empty when skill embeddings are not initialized", () => {
    // Skills exist but no embeddings computed → all get score 0
    const result = selectSkills([1, 0, 0], skills, 0.3);
    expect(result).toEqual([]);
  });

  it("respects maxSkills limit", () => {
    // Even with no embeddings (score 0), if threshold is 0, all match
    const result = selectSkills([1, 0, 0], skills, 0, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });
});
