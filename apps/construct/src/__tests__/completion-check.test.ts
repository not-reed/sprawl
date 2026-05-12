import { describe, it, expect } from "vitest";
import { checkCompletion } from "../completion-check.js";
import type { TurnResult } from "../agent-types.js";

function makeTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    responseText: "",
    toolCalls: [],
    totalUsage: { input: 0, output: 0, cost: 0 },
    hasUsage: false,
    toolErrors: [],
    toolSuccesses: 0,
    ...overrides,
  };
}

describe("checkCompletion", () => {
  it("returns complete for a question", () => {
    const result = makeTurnResult({ responseText: "What would you like me to do?" });
    expect(checkCompletion("write a poem", result).complete).toBe(true);
  });

  it("returns incomplete for short response to a task without tools", () => {
    const result = makeTurnResult({ responseText: "Okay." });
    expect(checkCompletion("write a function", result).complete).toBe(false);
  });

  it("returns complete when accumulated text is substantial", () => {
    const result = makeTurnResult({ responseText: "Done." });
    const accumulated =
      "Here is the full implementation of the requested function with all edge cases handled.\n\nDone.";
    expect(checkCompletion("write a function", result, accumulated).complete).toBe(true);
  });

  it("returns incomplete when all tools failed", () => {
    const result = makeTurnResult({
      responseText: "I tried but it failed.",
      toolCalls: [{ id: "tc-1", name: "edit", args: {}, result: "error" }],
      toolErrors: [{ toolName: "edit", result: "error" }],
      toolSuccesses: 0,
    });
    expect(checkCompletion("fix the bug", result).complete).toBe(false);
  });

  it("returns complete for successful tool execution with summary", () => {
    const result = makeTurnResult({
      responseText: "I've fixed the bug. The issue was...",
      toolCalls: [{ id: "tc-1", name: "edit", args: {}, result: "success" }],
      toolSuccesses: 1,
    });
    expect(checkCompletion("fix the bug", result).complete).toBe(true);
  });

  it("does not force continuation for short non-task messages", () => {
    const result = makeTurnResult({ responseText: "Sure thing." });
    expect(checkCompletion("thanks", result).complete).toBe(true);
  });

  it("returns incomplete when no summary after tool execution", () => {
    const result = makeTurnResult({
      responseText: "",
      toolCalls: [{ id: "tc-1", name: "read", args: {}, result: "file content" }],
      toolSuccesses: 1,
    });
    expect(checkCompletion("read that file", result).complete).toBe(false);
  });

  it("uses accumulated stats to detect earlier failures on a clean turn", () => {
    // Turn 2 has no tools, but turn 1 failed everything.
    const result = makeTurnResult({
      responseText: "I couldn't do it.",
      toolCalls: [],
      toolErrors: [],
      toolSuccesses: 0,
    });
    expect(
      checkCompletion("fix the bug", result, undefined, {
        toolErrorCount: 2,
        toolSuccessCount: 0,
      }).complete,
    ).toBe(false);
  });
});
