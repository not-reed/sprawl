import type { Observation, ContextWindow } from './types.js'

/**
 * Render active observations as a text prefix for the LLM context.
 * This becomes the stable, prompt-cacheable prefix before active messages.
 */
export function renderObservations(observations: Observation[]): string {
  if (observations.length === 0) return ''

  const lines = observations.map((o) => {
    const priority = o.priority === 'high' ? '!' : o.priority === 'low' ? '~' : '-'
    return `${priority} [${o.observation_date}] ${o.content}`
  })

  return lines.join('\n')
}

/**
 * Build the context window from observations and active (un-observed) messages.
 * Pure function — no DB access, no side effects.
 */
export function buildContextWindow(
  observations: Observation[],
  activeMessages: Array<{
    role: string
    content: string
    telegram_message_id?: number | null
  }>,
): ContextWindow {
  return {
    observations: renderObservations(observations),
    activeMessages,
  }
}
