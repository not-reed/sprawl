import type { WorkerModelConfig, ReflectorInput, ReflectorOutput, CairnLogger } from './types.js'
import { isDegenerateRaw, sanitizeObservations } from './observer.js'

const REFLECTOR_PROMPT = `You reorganize and condense observations. Your output replaces the input — any information you drop is permanently lost. Treat this as the sole memory of the conversation.

## What You Receive

A list of dated observations, each with an ID, priority, and date. Some may overlap, contradict, or be stale.

## Merge Rules

Combine observations that describe the same topic into one richer observation. Keep each merged observation self-contained — it must make sense without the others.
Do not merge unrelated facts just because they share a date. "User lives in Portland" and "User has a dentist appointment" stay separate.
When merging, keep the most recent observation_date of the group.
Prefer specifics over generalities: "User uses Neovim with LazyVim" beats "User uses a code editor."

## Supersession

When a newer observation contradicts or updates an older one, emit only the newer version and list the old ID in superseded_ids.
Corrections are authoritative: if the user said "I moved to Portland" after earlier saying "I live in Seattle", supersede the Seattle observation.
Only supersede observations whose IDs appear in the input. Never invent IDs.

## Temporal Handling

Preserve observation_date on every output observation.
Recent observations (last few days) should retain full detail. Older observations can be compressed more aggressively, but do not drop high-priority facts regardless of age.
When merging observations from different dates, use the most recent date.

## Observation Quality

One fact per observation. If a merge would produce a multi-topic sentence, split it back out.
Present tense for ongoing states ("User lives in Portland"), past tense for completed events ("User visited Tokyo in December 2024").
Use precise action verbs: "subscribed to", "purchased", "scheduled" — not "got", "did", "is getting".
Keep each observation under ~200 characters when possible; go longer only to preserve essential detail.

## Priority

- high: decisions, commitments, scheduled events, personal facts, state changes, corrections
- medium: preferences, interests, opinions, general context
- low: acknowledgments, minor details, ambient conversation

Drop low-priority observations that add no lasting value. Never drop high-priority observations unless superseded by a newer correction.

## Output Format

Return a JSON object with this exact shape:
{
  "observations": [
    {
      "content": "User works as a software engineer and is building a personal AI companion in TypeScript",
      "priority": "high",
      "observation_date": "2025-01-15"
    }
  ],
  "superseded_ids": ["id-of-old-seattle-obs", "id-of-redundant-obs"]
}

superseded_ids must only contain IDs from the input. If nothing is superseded, return an empty array.

Respond ONLY with JSON, no fences.`

/**
 * Filter superseded IDs to only those present in the input set.
 * Prevents hallucinated IDs from propagating.
 */
export function validateSupersededIds(
  supersededIds: unknown[],
  inputIds: Set<string>,
): string[] {
  return supersededIds.filter(
    (id): id is string => typeof id === 'string' && inputIds.has(id),
  )
}

/**
 * Condense a set of observations into a tighter set using an LLM.
 * Returns new observations and IDs of observations that should be marked superseded.
 */
export async function reflect(
  config: WorkerModelConfig,
  input: ReflectorInput,
  logger?: CairnLogger,
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

  // Check for degenerate output before parsing
  if (isDegenerateRaw(text)) {
    logger?.warning(`Degenerate reflector response detected (length=${text.length}), discarding`)
    return { observations: [], superseded_ids: [] }
  }

  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    logger?.warning(`Failed to parse reflector response (length=${text.length}): ${text.slice(0, 150)}...${text.slice(-100)}`)
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

  // Sanitize: truncate, cap, deduplicate
  result.observations = sanitizeObservations(result.observations, input.observations.length)

  // Validate superseded IDs — only allow IDs that were in the input
  const inputIds = new Set(input.observations.map((o) => o.id))
  result.superseded_ids = validateSupersededIds(result.superseded_ids, inputIds)

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
