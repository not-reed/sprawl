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

const MS_PER_DAY = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Convert an absolute date string into a human-relative timestamp
 * (e.g. "today", "yesterday", "3 days ago", "last Tuesday").
 * Falls back to YYYY-MM-DD for dates older than ~1 year.
 */
export function formatRelativeDate(dateStr: string, now: Date = new Date()): string {
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / MS_PER_DAY);

  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return `last ${WEEKDAYS[date.getUTCDay()]}`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return dateStr.slice(0, 10); // YYYY-MM-DD fallback
}

/** Recency decay curve matching the formula used in memory recall. */
function observationRecencyDecay(createdAt: string, now: Date = new Date()): number {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) return 0;
  const ageInDays = (now.getTime() - createdMs) / MS_PER_DAY;
  return ageInDays <= 7 ? 1.0 : 1.0 / (1.0 + Math.log2(ageInDays / 7));
}

const PRIORITY_RANK: Record<Observation["priority"], number> = { high: 3, medium: 2, low: 1 };

/**
 * Render active observations as a text prefix for the LLM context.
 * This becomes the stable, prompt-cacheable prefix before active messages.
 */
export function renderObservations(observations: Observation[], now?: Date): string {
  if (observations.length === 0) return "";

  const ref = now ?? new Date();
  const lines = observations.map((o) => {
    const priority = o.priority === "high" ? "!" : o.priority === "low" ? "~" : "-";
    return `${priority} [${formatRelativeDate(o.observation_date, ref)}] ${o.content}`;
  });

  return lines.join("\n");
}

/**
 * Render observations within a token budget.
 * Eviction order: composite score (priority × recency decay) desc, then generation desc.
 * After selection, re-sorts included observations by created_at ASC for coherent rendering.
 */
export function renderObservationsWithBudget(
  observations: Observation[],
  budget: number = OBSERVATION_BUDGET,
  now?: Date,
): BudgetedObservations {
  if (observations.length === 0) {
    return { text: "", included: 0, evicted: 0, totalTokens: 0 };
  }

  const ref = now ?? new Date();

  // Sort by composite score (priority × recency decay) desc, then generation desc,
  // then created_at desc (newest first) for greedy packing
  const sorted = [...observations].toSorted((a, b) => {
    const scoreA = PRIORITY_RANK[a.priority] * observationRecencyDecay(a.created_at, ref);
    const scoreB = PRIORITY_RANK[b.priority] * observationRecencyDecay(b.created_at, ref);
    if (scoreA !== scoreB) return scoreB - scoreA;
    const gDiff = (b.generation ?? 0) - (a.generation ?? 0);
    if (gDiff !== 0) return gDiff;
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
    text: renderObservations(ordered, ref),
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
