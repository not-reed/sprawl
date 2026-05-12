import { estimateTokens } from "@repo/cairn";
import type { TurnResult } from "./agent-types.js";

const MIN_RESPONSE_TOKENS = 15;

/** Maximum number of internal continuation loops per user message. */
export const MAX_CONTINUATIONS = 3;

export interface CompletionCheck {
  complete: boolean;
  reason?: string;
}

const TASK_KEYWORDS = [
  "write",
  "create",
  "build",
  "generate",
  "make",
  "implement",
  "fix",
  "update",
  "deploy",
  "refactor",
  "test",
];

const KEYWORD_PATTERNS = TASK_KEYWORDS.map((k) => new RegExp(`\\b${k}\\b`));

function looksLikeTask(message: string): boolean {
  const lower = message.toLowerCase();
  return KEYWORD_PATTERNS.some((regex) => regex.test(lower));
}

export interface AccumulatedStats {
  toolErrorCount: number;
  toolSuccessCount: number;
}

/**
 * Heuristic check for whether the agent stopped before fully addressing the
 * user's request.  Fast, cheap, and conservative — returns `complete: true` by
 * default so we only force continuation in clear-cut cases.
 *
 * @param accumulatedText - Optional accumulated text across continuation turns.
 *   When provided, the heuristic evaluates total progress instead of the
 *   latest turn in isolation.
 * @param accumulatedStats - Running totals across continuation turns so that a
 *   later turn with no tools still reflects earlier failures.
 */
export function checkCompletion(
  userMessage: string,
  result: TurnResult,
  accumulatedText?: string,
  accumulatedStats?: AccumulatedStats,
): CompletionCheck {
  const text = (accumulatedText ?? result.responseText).trim();
  const totalErrors = accumulatedStats?.toolErrorCount ?? result.toolErrors.length;
  const totalSuccesses = accumulatedStats?.toolSuccessCount ?? result.toolSuccesses;

  // If the agent is asking a question, it's engaging the user — not early stopping.
  if (text.endsWith("?")) {
    return { complete: true };
  }

  // No tools used and very short response for a task-like request → likely incomplete.
  if (
    result.toolCalls.length === 0 &&
    estimateTokens(text) < MIN_RESPONSE_TOKENS &&
    looksLikeTask(userMessage)
  ) {
    return {
      complete: false,
      reason: "Short response without tool usage for a task-oriented request",
    };
  }

  // All tool calls failed and nothing was resolved.
  if (totalErrors > 0 && totalSuccesses === 0) {
    return {
      complete: false,
      reason: "All tool calls failed and the issue was not resolved",
    };
  }

  // Tools ran but no summary / follow-up text at all.
  if (text.length === 0 && result.toolCalls.length > 0) {
    return {
      complete: false,
      reason: "No summary provided after tool execution",
    };
  }

  // TODO: LLM-based fallback for edge cases where heuristics are uncertain.
  // For now, default to complete to avoid spurious loops.
  return { complete: true };
}
