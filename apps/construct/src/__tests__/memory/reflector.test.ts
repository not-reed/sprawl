import { describe, it, expect } from 'vitest'
import { validateSupersededIds } from '@repo/cairn'
import { isDegenerateRaw, sanitizeObservations } from '@repo/cairn'

describe('validateSupersededIds', () => {
  it('keeps IDs present in input set', () => {
    const inputIds = new Set(['a', 'b', 'c'])
    const result = validateSupersededIds(['a', 'c'], inputIds)
    expect(result).toEqual(['a', 'c'])
  })

  it('filters out IDs not in input set', () => {
    const inputIds = new Set(['a', 'b'])
    const result = validateSupersededIds(['a', 'x', 'y', 'b'], inputIds)
    expect(result).toEqual(['a', 'b'])
  })

  it('filters out non-string values', () => {
    const inputIds = new Set(['a'])
    const result = validateSupersededIds(['a', 42, null, undefined, true], inputIds)
    expect(result).toEqual(['a'])
  })

  it('returns empty array when no IDs match', () => {
    const inputIds = new Set(['a', 'b'])
    const result = validateSupersededIds(['x', 'y', 'z'], inputIds)
    expect(result).toEqual([])
  })

  it('returns empty array for empty input', () => {
    const inputIds = new Set(['a'])
    const result = validateSupersededIds([], inputIds)
    expect(result).toEqual([])
  })
})

describe('reflector robustness (shared functions)', () => {
  const obs = (content: string, priority: 'low' | 'medium' | 'high' = 'medium') => ({
    content,
    priority,
    observation_date: '2025-01-15',
  })

  it('isDegenerateRaw catches repeated output from reflector', () => {
    // Simulate a model stuck in a loop producing the same JSON block
    const block = '{"content":"User likes cats","priority":"high","observation_date":"2025-01-15"},'
    const repeated = block.repeat(500)
    expect(isDegenerateRaw(repeated)).toBe(true)
  })

  it('sanitizeObservations deduplicates merged observations', () => {
    // Reflector might emit duplicates when merging
    const result = sanitizeObservations(
      [obs('User lives in Portland'), obs('User works remotely'), obs('User lives in Portland')],
      10,
    )
    expect(result).toHaveLength(2)
    expect(result.map((o) => o.content)).toEqual([
      'User lives in Portland',
      'User works remotely',
    ])
  })

  it('sanitizeObservations caps based on input observation count', () => {
    const observations = Array.from({ length: 80 }, (_, i) => obs(`merged fact ${i}`))
    // 5 input observations → cap = max(15, 50) = 50
    const result = sanitizeObservations(observations, 5)
    expect(result).toHaveLength(50)
  })
})
