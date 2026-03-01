import type { WorkerModelConfig, ObserverInput, ObserverOutput, CairnLogger } from './types.js'

const OBSERVER_PROMPT = `You extract observations from conversation. You compress raw messages into facts, events, preferences, and state changes. Each observation is a standalone record — it may be the only trace of what was said.

## Source Authority

User statements are authoritative fact. "I moved to Portland" → record as fact, don't hedge.
User questions are requests, not facts — "Is Portland nice?" does not mean the user is in Portland.
When the user corrects prior information, treat the correction as canonical.
When the assistant provides lists or recommendations, capture distinguishing details of each item the user engages with.

## Temporal Anchoring

Every observation must include the date it was said in observation_date (YYYY-MM-DD).
Messages have timestamps — use them as the baseline date.
Resolve relative references to calendar dates: "next Tuesday" on 2025-01-06 → 2025-01-14.
"Yesterday", "last week", "two days ago" → compute from the message timestamp.
Vague references ("recently", "soon", "a while ago") stay as-is in content — do not fabricate specific dates for them.
Future dates go in content: "User has a dentist appointment on 2025-03-05." The observation_date is still when it was said.

## Observation Quality

One fact per observation. Split multi-fact messages into separate observations, each with its own date.
Frame state changes explicitly: "User switched from vim to VS Code" — this signals prior info is superseded.
Use precise action verbs: "subscribed to", "purchased", "scheduled", "migrated to", "cancelled" — not "got", "did", "is getting".
Short and medium user messages should be captured near-verbatim; these observations may be the only record.
Preserve distinguishing attributes when the user discusses items from a list (e.g. "picked the 2BR with rooftop access", not "picked an apartment").
Do not repeat observations across turns if nothing new was said.
Omit pleasantries, filler, thank-yous, and meta-discussion about the AI.
Present tense for ongoing states ("User lives in Portland"), past tense for completed events ("User visited Tokyo in December 2024").
Keep each observation under ~200 characters when possible; go longer only to preserve essential detail.

## Priority

- high: decisions, commitments, scheduled events, personal facts, state changes, corrections to prior info
- medium: preferences, interests, opinions, general context, questions asked
- low: acknowledgments, minor details, ambient conversation

## Output Format

Return a JSON object with this exact shape:
{
  "observations": [
    {
      "content": "User scheduled a dentist appointment for 2025-03-05 at 9am",
      "priority": "high",
      "observation_date": "2025-01-15"
    },
    {
      "content": "User switched from Spotify to Apple Music",
      "priority": "high",
      "observation_date": "2025-01-15"
    },
    {
      "content": "User prefers window seats on flights",
      "priority": "medium",
      "observation_date": "2025-01-15"
    }
  ]
}

Respond ONLY with JSON, no fences.`

/**
 * Detect degenerate LLM output (repetition loops, impossibly large responses).
 * Called on raw text before JSON parsing.
 */
export function isDegenerateRaw(text: string): boolean {
  if (text.length > 50_000) return true

  const blockSize = 100
  const seen = new Map<string, number>()
  for (let i = 0; i + blockSize <= text.length; i += blockSize) {
    const block = text.slice(i, i + blockSize)
    const count = (seen.get(block) ?? 0) + 1
    if (count >= 3) return true
    seen.set(block, count)
  }

  return false
}

/**
 * Sanitize parsed observations: truncate long content, cap count, deduplicate.
 */
export function sanitizeObservations(
  observations: ObserverOutput['observations'],
  inputMessageCount: number,
): ObserverOutput['observations'] {
  // Deduplicate by content
  const seen = new Set<string>()
  const deduped = observations.filter((o) => {
    if (seen.has(o.content)) return false
    seen.add(o.content)
    return true
  })

  // Cap total count
  const cap = Math.max(inputMessageCount * 3, 50)
  const capped = deduped.slice(0, cap)

  // Truncate long content
  return capped.map((o) =>
    o.content.length > 2000
      ? { ...o, content: o.content.slice(0, 2000) + '...' }
      : o,
  )
}

/**
 * Compress a set of messages into observations using an LLM.
 */
export async function observe(
  config: WorkerModelConfig,
  input: ObserverInput,
  logger?: CairnLogger,
): Promise<ObserverOutput & { usage?: { input_tokens: number; output_tokens: number } }> {
  const messagesText = input.messages
    .map((m) => {
      const ts = m.created_at ? `[${m.created_at}] ` : ''
      return `${ts}${m.role}: ${m.content}`
    })
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
        { role: 'system', content: OBSERVER_PROMPT },
        { role: 'user', content: messagesText },
      ],
      temperature: 0,
      max_tokens: 2048,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Observer API error: ${response.status} ${body}`)
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }

  const text = data.choices[0]?.message?.content?.trim()
  if (!text) {
    throw new Error('Empty response from observer model')
  }

  // Check for degenerate output before parsing
  if (isDegenerateRaw(text)) {
    logger?.warning(`Degenerate observer response detected (length=${text.length}), discarding`)
    return { observations: [] }
  }

  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    logger?.warning(`Failed to parse observer response (length=${text.length}): ${text.slice(0, 150)}...${text.slice(-100)}`)
    return { observations: [] }
  }

  const result = parsed as ObserverOutput
  if (!Array.isArray(result.observations)) result.observations = []

  // Validate and normalize
  const validPriorities = new Set(['low', 'medium', 'high'])
  result.observations = result.observations.filter(
    (o) =>
      o.content &&
      typeof o.content === 'string' &&
      validPriorities.has(o.priority),
  )

  // Sanitize: truncate, cap, deduplicate
  result.observations = sanitizeObservations(result.observations, input.messages.length)

  return {
    observations: result.observations,
    usage: data.usage
      ? {
          input_tokens: data.usage.prompt_tokens ?? 0,
          output_tokens: data.usage.completion_tokens ?? 0,
        }
      : undefined,
  }
}
