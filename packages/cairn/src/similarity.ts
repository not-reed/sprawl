/** Named similarity thresholds for embedding cosine distance. */
export const SIMILARITY = {
  /** Default for memory recall (FTS5 + embedding hybrid). */
  RECALL_DEFAULT: 0.3 as number,
  /** Stricter recall — fewer but more relevant results. */
  RECALL_STRICT: 0.4 as number,
  /** Minimum similarity for a recent memory to be injected into the preamble.
   *  Below this, the memory is silently skipped — model can't volunteer what it can't see. */
  RECENT_MEMORY_MIN: 0.2 as number,
  /** Graph node search by embedding. */
  GRAPH_SEARCH: 0.3 as number,
  /** Tool pack selection threshold. */
  PACK_SELECTION: 0.3 as number,
  /** Skill selection threshold. Must be high enough to reject noise from short/generic queries. */
  SKILL_SELECTION: 0.45 as number,
};
