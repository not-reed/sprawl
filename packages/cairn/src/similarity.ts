/** Named similarity thresholds for embedding cosine distance. */
export const SIMILARITY = {
  /** Default for memory recall (FTS5 + embedding hybrid). */
  RECALL_DEFAULT: 0.3 as number,
  /** Stricter recall — fewer but more relevant results. */
  RECALL_STRICT: 0.4 as number,
  /** Graph node search by embedding. */
  GRAPH_SEARCH: 0.3 as number,
  /** Tool pack selection threshold. */
  PACK_SELECTION: 0.3 as number,
  /** Skill selection threshold. Slightly higher to avoid false matches. */
  SKILL_SELECTION: 0.35 as number,
};
