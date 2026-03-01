import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateMessageTokens } from '../tokens.js'

describe('estimateTokens', () => {
  it('estimates tokens from string length', () => {
    // 20 chars → 5 tokens (20/4)
    expect(estimateTokens('12345678901234567890')).toBe(5)
  })

  it('rounds up partial tokens', () => {
    // 5 chars → ceil(5/4) = 2
    expect(estimateTokens('hello')).toBe(2)
  })

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('estimateMessageTokens', () => {
  it('includes per-message overhead', () => {
    const tokens = estimateMessageTokens([
      { role: 'user', content: '12345678901234567890' }, // 5 content + 4 overhead = 9
    ])
    expect(tokens).toBe(9)
  })

  it('sums across multiple messages', () => {
    const tokens = estimateMessageTokens([
      { role: 'user', content: '12345678901234567890' },     // 5 + 4 = 9
      { role: 'assistant', content: '12345678901234567890' }, // 5 + 4 = 9
    ])
    expect(tokens).toBe(18)
  })

  it('returns 0 for empty array', () => {
    expect(estimateMessageTokens([])).toBe(0)
  })
})
