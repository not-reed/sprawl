import { describe, it, expect } from 'vitest'
import { renderObservations, buildContextWindow, renderObservationsWithBudget } from '@repo/cairn'
import type { Observation } from '@repo/cairn'

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

describe('renderObservationsWithBudget', () => {
  it('returns empty result for no observations', () => {
    const result = renderObservationsWithBudget([])
    expect(result).toEqual({ text: '', included: 0, evicted: 0, totalTokens: 0 })
  })

  it('includes all observations when under budget', () => {
    const obs = [
      makeObs({ id: '1', content: 'First', token_count: 10 }),
      makeObs({ id: '2', content: 'Second', token_count: 10 }),
    ]
    const result = renderObservationsWithBudget(obs, 100)
    expect(result.included).toBe(2)
    expect(result.evicted).toBe(0)
    expect(result.totalTokens).toBe(20)
    expect(result.text).not.toContain('omitted')
    // Should match unbounded render
    expect(result.text).toBe(renderObservations(obs))
  })

  it('evicts low-priority observations first when over budget', () => {
    const obs = [
      makeObs({ id: '1', content: 'Important', priority: 'high', token_count: 50 }),
      makeObs({ id: '2', content: 'Meh', priority: 'low', token_count: 50 }),
      makeObs({ id: '3', content: 'Normal', priority: 'medium', token_count: 50 }),
    ]
    const result = renderObservationsWithBudget(obs, 100)
    expect(result.included).toBe(2)
    expect(result.evicted).toBe(1)
    expect(result.text).toContain('Important')
    expect(result.text).toContain('Normal')
    expect(result.text).not.toContain('Meh')
  })

  it('uses recency as tiebreaker within same priority', () => {
    const obs = [
      makeObs({ id: '1', content: 'Old', priority: 'medium', token_count: 60, created_at: '2024-01-01T00:00:00' }),
      makeObs({ id: '2', content: 'New', priority: 'medium', token_count: 60, created_at: '2024-01-15T00:00:00' }),
    ]
    const result = renderObservationsWithBudget(obs, 60)
    expect(result.included).toBe(1)
    expect(result.text).toContain('New')
    expect(result.text).not.toContain('Old')
  })

  it('re-sorts included observations chronologically', () => {
    const obs = [
      makeObs({ id: '1', content: 'A', priority: 'high', token_count: 10, created_at: '2024-01-01T00:00:00', observation_date: '2024-01-01' }),
      makeObs({ id: '2', content: 'B', priority: 'low', token_count: 10, created_at: '2024-01-02T00:00:00', observation_date: '2024-01-02' }),
      makeObs({ id: '3', content: 'C', priority: 'high', token_count: 10, created_at: '2024-01-03T00:00:00', observation_date: '2024-01-03' }),
    ]
    const result = renderObservationsWithBudget(obs, 30)
    // All fit — should be in created_at order: A, B, C
    const lines = result.text.split('\n')
    expect(lines[0]).toContain('A')
    expect(lines[1]).toContain('B')
    expect(lines[2]).toContain('C')
  })

  it('always includes at least one observation even if it exceeds budget', () => {
    const obs = [makeObs({ id: '1', content: 'Huge observation', token_count: 10000 })]
    const result = renderObservationsWithBudget(obs, 100)
    expect(result.included).toBe(1)
    expect(result.evicted).toBe(0)
    expect(result.totalTokens).toBe(10000)
    expect(result.text).toContain('Huge observation')
  })

  it('falls back to estimateTokens when token_count is 0', () => {
    const obs = [
      makeObs({ id: '1', content: 'x'.repeat(400), token_count: 0 }), // ~100 tokens
      makeObs({ id: '2', content: 'y'.repeat(400), token_count: 0 }), // ~100 tokens
    ]
    const result = renderObservationsWithBudget(obs, 100)
    expect(result.included).toBe(1)
    expect(result.evicted).toBe(1)
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
