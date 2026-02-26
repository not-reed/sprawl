import { toolLog } from './logger.js'

const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small'

/**
 * Generate an embedding vector via OpenRouter's OpenAI-compatible endpoint.
 */
export async function generateEmbedding(
  apiKey: string,
  text: string,
  model?: string,
): Promise<number[]> {
  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model ?? DEFAULT_EMBEDDING_MODEL,
      input: text,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    toolLog.error`Embedding API error (${response.status}): ${body}`
    throw new Error(`Embedding API error: ${response.status} ${body}`)
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>
  }

  return data.data[0].embedding
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}
