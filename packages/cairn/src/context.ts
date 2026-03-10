import type { Observation, ContextWindow } from "./types.js";
import { estimateTokens } from "./tokens.js";

/** Token budget for observation rendering. Tunable. */
export const OBSERVATION_BUDGET = 8_000;

export interface BudgetedObservations {
  text: string;
  included: number;
  evicted: number;
  totalTokens: number;
}

/**
 * Render active observations as a text prefix for the LLM context.
 * This becomes the stable, prompt-cacheable prefix before active messages.
 */
export function renderObservations(observations: Observation[]): string {
  if (observations.length === 0) return "";

  const lines = observations.map((o) => {
    const priority = o.priority === "high" ? "!" : o.priority === "low" ? "~" : "-";
    return `${priority} [${o.observation_date}] ${o.content}`;
  });

  return lines.join("\n");
}

const PRIORITY_RANK: Record<Observation["priority"], number> = { high: 3, medium: 2, low: 1 };

/**
 * Render observations within a token budget.
 * Eviction order: lowest priority first, then oldest first.
 * After selection, re-sorts included observations by created_at ASC for coherent rendering.
 */
export function renderObservationsWithBudget(
  observations: Observation[],
  budget: number = OBSERVATION_BUDGET,
): BudgetedObservations {
  if (observations.length === 0) {
    return { text: "", included: 0, evicted: 0, totalTokens: 0 };
  }

  // Sort by priority desc, then created_at desc (newest first) for greedy packing
  const sorted = [...observations].toSorted((a, b) => {
    const pDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (pDiff !== 0) return pDiff;
    return b.created_at.localeCompare(a.created_at);
  });

  const included: Observation[] = [];
  let totalTokens = 0;

  for (const obs of sorted) {
    const tokens = obs.token_count || estimateTokens(obs.content);
    if (totalTokens + tokens > budget && included.length > 0) break;
    included.push(obs);
    totalTokens += tokens;
  }

  // Re-sort included by created_at ASC for chronological rendering
  const ordered = included.toSorted((a, b) => a.created_at.localeCompare(b.created_at));

  return {
    text: renderObservations(ordered),
    included: included.length,
    evicted: observations.length - included.length,
    totalTokens,
  };
}

/**
 * Build the context window from observations and active (un-observed) messages.
 * Pure function — no DB access, no side effects.
 */
export function buildContextWindow(
  observations: Observation[],
  activeMessages: Array<{
    role: string;
    content: string;
  }>,
): ContextWindow {
  return {
    observations: renderObservations(observations),
    activeMessages,
  };
}
