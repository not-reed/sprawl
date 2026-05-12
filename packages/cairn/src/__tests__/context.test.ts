import { describe, it, expect } from "vitest";
import {
  renderObservations,
  buildContextWindow,
  renderObservationsWithBudget,
  formatRelativeDate,
} from "../context.js";
import { createTestObservation } from "./fixtures.js";

const makeObs = createTestObservation;
const FIXED_NOW = new Date("2026-01-15T12:00:00Z");

describe("formatRelativeDate", () => {
  const now = new Date("2026-05-11T12:00:00Z");

  it("returns 'today' for same-day dates", () => {
    expect(formatRelativeDate("2026-05-11T08:00:00Z", now)).toBe("today");
  });

  it("returns 'yesterday' for 1-day-old dates", () => {
    expect(formatRelativeDate("2026-05-10T08:00:00Z", now)).toBe("yesterday");
  });

  it("returns 'N days ago' for recent dates", () => {
    expect(formatRelativeDate("2026-05-08T08:00:00Z", now)).toBe("3 days ago");
  });

  it("returns 'last {weekday}' for 7-13 day old dates", () => {
    expect(formatRelativeDate("2026-05-04T08:00:00Z", now)).toBe("last Monday");
  });

  it("returns 'N weeks ago' for 2-4 week old dates", () => {
    expect(formatRelativeDate("2026-04-20T08:00:00Z", now)).toBe("3 weeks ago");
  });

  it("returns 'N months ago' for 1-11 month old dates", () => {
    expect(formatRelativeDate("2026-02-01T08:00:00Z", now)).toBe("3 months ago");
  });

  it("falls back to YYYY-MM-DD for dates older than 1 year", () => {
    expect(formatRelativeDate("2024-01-15T00:00:00Z", now)).toBe("2024-01-15");
  });
});

describe("renderObservations", () => {
  it("renders empty string for no observations", () => {
    expect(renderObservations([])).toBe("");
  });

  it("renders medium priority with dash prefix", () => {
    const result = renderObservations(
      [makeObs({ content: "A fact", priority: "medium", observation_date: "2024-01-15" })],
      FIXED_NOW,
    );
    expect(result).toBe("- [2024-01-15] A fact");
  });

  it("renders high priority with ! prefix", () => {
    const result = renderObservations(
      [makeObs({ content: "Important", priority: "high", observation_date: "2024-01-15" })],
      FIXED_NOW,
    );
    expect(result).toBe("! [2024-01-15] Important");
  });

  it("renders low priority with ~ prefix", () => {
    const result = renderObservations(
      [makeObs({ content: "Minor", priority: "low", observation_date: "2024-01-15" })],
      FIXED_NOW,
    );
    expect(result).toBe("~ [2024-01-15] Minor");
  });

  it("renders multiple observations separated by newlines", () => {
    const obs = [
      makeObs({ id: "1", content: "First", priority: "high", observation_date: "2024-01-15" }),
      makeObs({ id: "2", content: "Second", priority: "medium", observation_date: "2024-01-16" }),
    ];
    const result = renderObservations(obs, FIXED_NOW);
    expect(result).toBe("! [2024-01-15] First\n- [2024-01-16] Second");
  });

  it("uses relative dates for recent observations", () => {
    const today = "2026-01-15";
    const obs = [
      makeObs({ content: "Fresh", observation_date: today, created_at: `${today}T00:00:00Z` }),
    ];
    expect(renderObservations(obs, FIXED_NOW)).toBe("- [today] Fresh");
  });
});

describe("renderObservationsWithBudget (basic)", () => {
  it("returns empty result for no observations", () => {
    const result = renderObservationsWithBudget([]);
    expect(result).toEqual({ text: "", included: 0, evicted: 0, totalTokens: 0 });
  });

  it("includes all observations when under budget", () => {
    const obs = [
      makeObs({ id: "1", content: "First", token_count: 10, observation_date: "2024-01-15" }),
      makeObs({ id: "2", content: "Second", token_count: 10, observation_date: "2024-01-15" }),
    ];
    const result = renderObservationsWithBudget(obs, 100, FIXED_NOW);
    expect(result.included).toBe(2);
    expect(result.evicted).toBe(0);
    expect(result.totalTokens).toBe(20);
    expect(result.text).not.toContain("omitted");
    expect(result.text).toBe(renderObservations(obs, FIXED_NOW));
  });

  it("evicts low-priority observations first when over budget", () => {
    const obs = [
      makeObs({
        id: "1",
        content: "Important",
        priority: "high",
        token_count: 50,
        observation_date: "2024-01-15",
      }),
      makeObs({
        id: "2",
        content: "Meh",
        priority: "low",
        token_count: 50,
        observation_date: "2024-01-15",
      }),
      makeObs({
        id: "3",
        content: "Normal",
        priority: "medium",
        token_count: 50,
        observation_date: "2024-01-15",
      }),
    ];
    const result = renderObservationsWithBudget(obs, 100, FIXED_NOW);
    expect(result.included).toBe(2);
    expect(result.evicted).toBe(1);
    expect(result.text).toContain("Important");
    expect(result.text).toContain("Normal");
    expect(result.text).not.toContain("Meh");
  });

  it("re-sorts included observations chronologically", () => {
    const obs = [
      makeObs({
        id: "1",
        content: "A",
        priority: "high",
        token_count: 10,
        created_at: "2024-01-01T00:00:00",
        observation_date: "2024-01-01",
      }),
      makeObs({
        id: "2",
        content: "B",
        priority: "low",
        token_count: 10,
        created_at: "2024-01-02T00:00:00",
        observation_date: "2024-01-02",
      }),
      makeObs({
        id: "3",
        content: "C",
        priority: "high",
        token_count: 10,
        created_at: "2024-01-03T00:00:00",
        observation_date: "2024-01-03",
      }),
    ];
    const result = renderObservationsWithBudget(obs, 30, FIXED_NOW);
    const lines = result.text.split("\n");
    expect(lines[0]).toContain("A");
    expect(lines[1]).toContain("B");
    expect(lines[2]).toContain("C");
  });
});

describe("renderObservationsWithBudget (edge cases)", () => {
  it("always includes at least one observation even if it exceeds budget", () => {
    const obs = [
      makeObs({
        id: "1",
        content: "Huge observation",
        token_count: 10000,
        observation_date: "2024-01-15",
      }),
    ];
    const result = renderObservationsWithBudget(obs, 100, FIXED_NOW);
    expect(result.included).toBe(1);
    expect(result.evicted).toBe(0);
    expect(result.totalTokens).toBe(10000);
    expect(result.text).toContain("Huge observation");
  });

  it("falls back to estimateTokens when token_count is 0", () => {
    const obs = [
      makeObs({
        id: "1",
        content: "x".repeat(400),
        token_count: 0,
        observation_date: "2024-01-15",
      }), // ~100 tokens
      makeObs({
        id: "2",
        content: "y".repeat(400),
        token_count: 0,
        observation_date: "2024-01-15",
      }), // ~100 tokens
    ];
    const result = renderObservationsWithBudget(obs, 100, FIXED_NOW);
    expect(result.included).toBe(1);
    expect(result.evicted).toBe(1);
  });
});

describe("renderObservationsWithBudget (recency weighting)", () => {
  it("uses recency as tiebreaker within same priority", () => {
    const obs = [
      makeObs({
        id: "1",
        content: "Old",
        priority: "medium",
        token_count: 60,
        created_at: "2024-01-01T00:00:00",
        observation_date: "2024-01-01",
      }),
      makeObs({
        id: "2",
        content: "New",
        priority: "medium",
        token_count: 60,
        created_at: "2024-01-15T00:00:00",
        observation_date: "2024-01-15",
      }),
    ];
    const result = renderObservationsWithBudget(obs, 60, FIXED_NOW);
    expect(result.included).toBe(1);
    expect(result.text).toContain("New");
    expect(result.text).not.toContain("Old");
  });

  it("prefers recent medium-priority over ancient high-priority", () => {
    const today = "2026-01-15";
    const oldDate = "2024-01-01T00:00:00Z";
    const obs = [
      makeObs({
        id: "1",
        content: "Old high",
        priority: "high",
        token_count: 60,
        created_at: oldDate,
        observation_date: oldDate,
      }),
      makeObs({
        id: "2",
        content: "New medium",
        priority: "medium",
        token_count: 60,
        created_at: `${today}T00:00:00Z`,
        observation_date: today,
      }),
    ];
    const result = renderObservationsWithBudget(obs, 60, FIXED_NOW);
    expect(result.included).toBe(1);
    expect(result.text).toContain("New medium");
    expect(result.text).not.toContain("Old high");
  });

  it("handles malformed created_at gracefully without crashing", () => {
    const obs = [
      makeObs({
        id: "1",
        content: "Bad date",
        priority: "high",
        token_count: 10,
        created_at: "not-a-date",
        observation_date: "2024-01-15",
      }),
      makeObs({
        id: "2",
        content: "Good date",
        priority: "medium",
        token_count: 10,
        created_at: "2026-01-15T00:00:00Z",
        observation_date: "2026-01-15",
      }),
    ];
    const result = renderObservationsWithBudget(obs, 20, FIXED_NOW);
    expect(result.included).toBeGreaterThanOrEqual(1);
    expect(result.text).toContain("Good date");
  });
});

describe("buildContextWindow", () => {
  it("returns empty observations and active messages", () => {
    const result = buildContextWindow([], []);
    expect(result.observations).toBe("");
    expect(result.activeMessages).toEqual([]);
  });

  it("passes through observations and messages", () => {
    const obs = [makeObs({ content: "Fact", observation_date: "2024-01-15" })];
    const msgs = [{ role: "user", content: "hello" }];
    const result = buildContextWindow(obs, msgs);
    expect(result.observations).toContain("Fact");
    expect(result.activeMessages).toHaveLength(1);
  });
});
