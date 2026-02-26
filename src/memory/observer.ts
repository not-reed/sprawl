import type { WorkerModelConfig, ObserverInput, ObserverOutput } from './types.js'
import { toolLog } from '../logger.js'

const OBSERVER_PROMPT = `You are an observation extractor. Your job is to compress a conversation into concise, dated observations.

Given a sequence of messages between a user and an assistant, extract the key information as bullet-point observations.

Rules:
- Each observation should be a single, self-contained bullet point
- Include the date/time context for each observation
- Assign priority: "high" (important facts, decisions, commitments), "medium" (general context), "low" (small talk, acknowledgments)
- Preserve concrete details: names, numbers, dates, preferences, decisions
- Omit pleasantries, filler, and meta-discussion about the AI itself
- Group related items into single observations when natural
- Use present tense for ongoing states, past tense for events

Return a JSON object with:
{
  "observations": [
    {
      "content": "User has a dentist appointment on March 5th at 9am",
      "priority": "high",
      "observation_date": "2024-01-15"
    }
  ]
}

Respond ONLY with the JSON object, no markdown fences or explanation.`

/**
 * Compress a set of messages into observations using an LLM.
 */
export async function observe(
  config: WorkerModelConfig,
  input: ObserverInput,
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

  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    toolLog.warning`Failed to parse observer response: ${text.slice(0, 200)}`
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
