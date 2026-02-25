import type { Skill } from './extensions/types.js'

/**
 * Base system prompt — static part that enables prompt caching.
 * Personality (SOUL.md), identity (IDENTITY.md), and user context (USER.md)
 * are injected separately as living documents. Dynamic context (date,
 * timezone, memories, skills) goes in the first user message.
 */
const BASE_SYSTEM_PROMPT = `You are a personal companion. Your personality, identity, and knowledge of your user are defined in the Soul, Identity, and User sections below — embody them.

Your tools describe their own capabilities. Use them freely; don't ask permission.

## Rules

- Be concise — this is Telegram, not an essay. Short replies unless detail is needed.
- Proactively store memories when the user shares something worth remembering.
- Search broadly when recalling — use general keywords, then filter.
- Confirm time and message before creating reminders.
- Explain what and why before self-editing source code.
- Never deploy without passing tests.
- Never edit files outside src/, cli/, or extensions/.

## Telegram Interactions

- telegram_react: React with emoji. Use for simple acknowledgments instead of text (e.g. "sounds good" → 👍 react, no text).
- telegram_reply_to: Reply to a specific older message using its [tg:ID].
- telegram_pin/unpin/get_pinned: Pin management.
- Message IDs appear as [tg:12345] prefixes in conversation history.
- User reactions appear as context annotations — respond naturally or not at all.

## Proactive Communication

When a scheduled reminder fires or you notice a meaningful connection in context, you may add something beyond the bare minimum — a relevant memory, a heads-up, or a thought that ties things together. Keep it natural and rare. Most of the time, wait to be spoken to.

## Identity Files

SOUL.md, IDENTITY.md, and USER.md are living documents — update them as the relationship evolves.
- Use identity_read to check current content before making changes.
- Use identity_update to write changes — it reloads automatically.
- SOUL.md: personality traits, values, communication style.
- IDENTITY.md: name, creature type, visual description, pronouns.
- USER.md: human context — name, location, preferences, interests, schedule.

## Extensions

- extensions/tools/ — TypeScript tools ({name, description, parameters, execute})
- extensions/skills/ — Markdown skills (YAML frontmatter + body)
- Extensions are for integrations, experiments, and personal workflows
- After creating or editing extension files, call extension_reload to activate changes.
- Native source (src/) is for core capabilities needing deep system access
`

/** Identity files for system prompt injection */
interface IdentityInput {
  soul?: string | null
  identity?: string | null
  user?: string | null
}

/** Cached system prompt (base + identity files) */
let cachedPrompt: string | null = null
let cachedKey: string | null = null

function identityCacheKey(id?: IdentityInput | null): string {
  if (!id) return ''
  return `${id.soul ?? ''}|${id.identity ?? ''}|${id.user ?? ''}`
}

/**
 * Get the full system prompt, with identity files appended if provided.
 * Caches the result until invalidated.
 */
export function getSystemPrompt(identity?: IdentityInput | null): string {
  const key = identityCacheKey(identity)
  if (cachedPrompt !== null && key === cachedKey) {
    return cachedPrompt
  }

  cachedKey = key
  let prompt = BASE_SYSTEM_PROMPT

  if (identity?.identity) {
    prompt += `\n## Identity\n${identity.identity}\n`
  }
  if (identity?.user) {
    prompt += `\n## User\n${identity.user}\n`
  }
  if (identity?.soul) {
    prompt += `\n## Soul\n${identity.soul}\n`
  }

  cachedPrompt = prompt
  return cachedPrompt
}

/** Invalidate the cached system prompt. Called on extension reload. */
export function invalidateSystemPromptCache(): void {
  cachedPrompt = null
  cachedKey = null
}

/**
 * Format current date+time in the configured timezone using Intl (built-in, no deps).
 */
export function formatNow(timezone: string): string {
  const now = new Date()
  return now.toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * Build a context preamble to prepend to the user's message.
 * This keeps the system prompt static/cacheable while injecting
 * per-request dynamic context, including recent memories for
 * pattern recognition and selected skills.
 */
export function buildContextPreamble(context: {
  timezone: string
  source: string
  dev?: boolean
  recentMemories?: Array<{ content: string; category: string; created_at: string }>
  relevantMemories?: Array<{ content: string; category: string; score?: number }>
  skills?: Skill[]
  replyContext?: string
}): string {
  const now = formatNow(context.timezone)
  const envLabel = context.dev ? ' | DEV MODE' : ''
  let preamble = `[Context: ${now} (${context.timezone}) | ${context.source}${envLabel}]\n`

  if (context.dev) {
    preamble += '[Running in development — hot reload is active, self_deploy is disabled]\n'
  }

  if (context.recentMemories && context.recentMemories.length > 0) {
    preamble += '\n[Recent memories — use these for context, pattern recognition, and continuity]\n'
    for (const m of context.recentMemories) {
      preamble += `- (${m.category}) ${m.content}\n`
    }
  }

  if (context.relevantMemories && context.relevantMemories.length > 0) {
    preamble += '\n[Potentially relevant memories]\n'
    for (const m of context.relevantMemories) {
      const score = m.score !== undefined ? ` (${(m.score * 100).toFixed(0)}% match)` : ''
      preamble += `- (${m.category}) ${m.content}${score}\n`
    }
  }

  if (context.skills && context.skills.length > 0) {
    preamble += '\n[Active skills — follow these instructions when relevant]\n'
    for (const skill of context.skills) {
      preamble += `\n### ${skill.name}\n${skill.body}\n`
    }
  }

  if (context.replyContext) {
    preamble += `\n[Replying to: "${context.replyContext.slice(0, 300)}"]\n`
  }

  return preamble + '\n'
}
