import type { WorkerModelConfig, ReflectorInput, ReflectorOutput } from './types.js'
import { toolLog } from '../logger.js'

const REFLECTOR_PROMPT = `You are an observation condenser. Your job is to take a set of observations and produce a tighter, more organized set.

Rules:
- Combine related observations into single, richer observations
- Remove observations that have been superseded by newer information
- Preserve high-priority items (decisions, commitments, important facts)
- Low-priority items can be dropped if they add no lasting value
- Keep observations self-contained — each should make sense alone
- Use present tense for ongoing states, past tense for events
- Assign accurate priority: "high", "medium", or "low"
- Return the IDs of observations that are now superseded (replaced or dropped)

Return a JSON object with:
{
  "observations": [
    {
      "content": "User works as a software engineer, prefers TypeScript, and is building a personal AI companion",
      "priority": "high",
      "observation_date": "2024-01-15"
    }
  ],
  "superseded_ids": ["obs-id-1", "obs-id-2"]
}

Respond ONLY with the JSON object, no markdown fences or explanation.`

/**
 * Condense a set of observations into a tighter set using an LLM.
 * Returns new observations and IDs of observations that should be marked superseded.
 */
export async function reflect(
  config: WorkerModelConfig,
  input: ReflectorInput,
): Promise<ReflectorOutput & { usage?: { input_tokens: number; output_tokens: number } }> {
  const observationsText = input.observations
    .map((o) => `[${o.id}] (${o.priority}, ${o.observation_date}) ${o.content}`)
    .join('\n')

  const response = await fetch(config.baseUrl ?? 'https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: REFLECTOR_PROMPT },
        { role: 'user', content: observationsText },
      ],
      temperature: 0,
      max_tokens: 2048,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Reflector API error: ${response.status} ${body}`)
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }

  const text = data.choices[0]?.message?.content?.trim()
  if (!text) {
    throw new Error('Empty response from reflector model')
  }

  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    toolLog.warning`Failed to parse reflector response: ${text.slice(0, 200)}`
    return { observations: [], superseded_ids: [] }
  }

  const result = parsed as ReflectorOutput
  if (!Array.isArray(result.observations)) result.observations = []
  if (!Array.isArray(result.superseded_ids)) result.superseded_ids = []

  // Validate observations
  const validPriorities = new Set(['low', 'medium', 'high'])
  result.observations = result.observations.filter(
    (o) =>
      o.content &&
      typeof o.content === 'string' &&
      validPriorities.has(o.priority),
  )

  // Validate superseded IDs — only allow IDs that were in the input
  const inputIds = new Set(input.observations.map((o) => o.id))
  result.superseded_ids = result.superseded_ids.filter(
    (id) => typeof id === 'string' && inputIds.has(id),
  )

  return {
    observations: result.observations,
    superseded_ids: result.superseded_ids,
    usage: data.usage
      ? {
          input_tokens: data.usage.prompt_tokens ?? 0,
          output_tokens: data.usage.completion_tokens ?? 0,
        }
      : undefined,
  }
}
