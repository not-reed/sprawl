import { withEmbeddingRetry, fetchErrorFromResponse } from "./retry.js";

const DEFAULT_EMBEDDING_MODEL = "qwen/qwen3-embedding-4b";

/**
 * Generate an embedding vector via OpenRouter's OpenAI-compatible endpoint.
 * Wrapped with retry for resilience against transient network failures (TypeError),
 * 5xx server errors, and 429 rate limits (respects Retry-After header).
 *
 * @param apiKey - OpenRouter API key.
 * @param text - Text to embed.
 * @param model - Embedding model (defaults to qwen/qwen3-embedding-4b).
 */
export async function generateEmbedding(
  apiKey: string,
  text: string,
  model?: string,
): Promise<number[]> {
  return withEmbeddingRetry(async () => {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model ?? DEFAULT_EMBEDDING_MODEL,
        input: text,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw fetchErrorFromResponse(response, body, "OpenRouter embeddings");
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data[0].embedding;
  });
}

/** Result for an individual text in a batch embedding call. */
export type EmbeddingResult =
  | { embedding: number[]; index: number }
  | { error: string; index: number };

/**
 * Generate embeddings for multiple texts in parallel.
 * Each text is individually retried — a failure for one text does not affect others.
 *
 * @param apiKey - OpenRouter API key.
 * @param texts - Texts to embed.
 * @param model - Embedding model (defaults to qwen/qwen3-embedding-4b).
 * @returns Array of results, each with an `index` matching the input position.
 */
export async function generateEmbeddings(
  apiKey: string,
  texts: string[],
  model?: string,
): Promise<EmbeddingResult[]> {
  return Promise.all(
    texts.map(async (text, index) => {
      try {
        const embedding = await generateEmbedding(apiKey, text, model);
        return { embedding, index };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
          index,
        };
      }
    }),
  );
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
