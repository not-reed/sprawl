import { EmbeddingError } from "./errors.js";

const DEFAULT_EMBEDDING_MODEL = "qwen/qwen3-embedding-4b";

/**
 * Generate an embedding vector via OpenRouter's OpenAI-compatible endpoint.
 * @param apiKey - OpenRouter API key.
 * @param text - Text to embed.
 * @param model - Embedding model (defaults to qwen/qwen3-embedding-4b).
 */
export async function generateEmbedding(
  apiKey: string,
  text: string,
  model?: string,
): Promise<number[]> {
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
    throw new EmbeddingError(`Embedding API error: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  return data.data[0].embedding;
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
