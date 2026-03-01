/**
 * Token estimation utilities.
 * Uses char/4 heuristic — good enough for threshold checks.
 * Designed to be swappable with a real tokenizer later.
 */

const CHARS_PER_TOKEN = 4

/**
 * Estimate token count from a string using char/4 heuristic.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Estimate total tokens for an array of messages.
 */
export function estimateMessageTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  let total = 0
  for (const msg of messages) {
    // ~4 tokens overhead per message (role, delimiters)
    total += 4 + estimateTokens(msg.content)
  }
  return total
}
