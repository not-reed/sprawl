import { describe, it, expect } from 'vitest'
import { renderObservations, buildContextWindow } from '../context.js'
import type { Observation } from '../types.js'

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 'obs-1',
    conversation_id: 'conv-1',
    content: 'Test observation',
    priority: 'medium',
    observation_date: '2024-01-15',
    source_message_ids: [],
    token_count: 10,
    generation: 0,
    superseded_at: null,
    created_at: '2024-01-15T00:00:00',
    ...overrides,
  }
}

describe('renderObservations', () => {
  it('renders empty string for no observations', () => {
    expect(renderObservations([])).toBe('')
  })

  it('renders medium priority with dash prefix', () => {
    const result = renderObservations([makeObs({ content: 'A fact', priority: 'medium' })])
    expect(result).toBe('- [2024-01-15] A fact')
  })

  it('renders high priority with ! prefix', () => {
    const result = renderObservations([makeObs({ content: 'Important', priority: 'high' })])
    expect(result).toBe('! [2024-01-15] Important')
  })

  it('renders low priority with ~ prefix', () => {
    const result = renderObservations([makeObs({ content: 'Minor', priority: 'low' })])
    expect(result).toBe('~ [2024-01-15] Minor')
  })

  it('renders multiple observations separated by newlines', () => {
    const obs = [
      makeObs({ id: '1', content: 'First', priority: 'high', observation_date: '2024-01-15' }),
      makeObs({ id: '2', content: 'Second', priority: 'medium', observation_date: '2024-01-16' }),
    ]
    const result = renderObservations(obs)
    expect(result).toBe('! [2024-01-15] First\n- [2024-01-16] Second')
  })
})

describe('buildContextWindow', () => {
  it('returns empty observations and active messages', () => {
    const result = buildContextWindow([], [])
    expect(result.observations).toBe('')
    expect(result.activeMessages).toEqual([])
  })

  it('passes through observations and messages', () => {
    const obs = [makeObs({ content: 'Fact' })]
    const msgs = [{ role: 'user', content: 'hello' }]
    const result = buildContextWindow(obs, msgs)
    expect(result.observations).toContain('Fact')
    expect(result.activeMessages).toHaveLength(1)
  })
})
