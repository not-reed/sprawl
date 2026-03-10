/** Error during memory operations (observe, reflect, promote, recall). */
export class MemoryError extends Error {
  override name = "MemoryError" as const;
}

/** Error during embedding generation or similarity computation. */
export class EmbeddingError extends Error {
  override name = "EmbeddingError" as const;
}

/** Error during graph entity extraction or traversal. */
export class GraphError extends Error {
  override name = "GraphError" as const;
}
