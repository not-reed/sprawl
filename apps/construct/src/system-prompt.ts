import { encode } from "@toon-format/toon";

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
- Use telegram ask before self-editing — let the user confirm the plan.
- When mentioning the current time, use ONLY the time from [Current time: ...]. Never guess.
- If you tell the user you will remind them about something later, create a schedule immediately. Do not make verbal promises to follow up without a real schedule behind them.
- When the user says a memory is wrong, outdated, or already happened, immediately call memory with action "forget" on it before responding. Do not just acknowledge — remove the bad memory.
- Never edit files outside the directories your tools allow.
- Message annotations like [YYYY-MM-DD HH:MM] and [tg:ID] in history are metadata — never include them in responses.

## Tools

Your tools use actions instead of separate commands:
- memory: store, recall, forget, graph, stats
- schedule: create, list, cancel
- secret: store, list, delete
- skill: create, update, list, delete, inspect, feedback, conflicts
- read: file, directory, identity
- edit: source, identity
- web: search, read
- shell: (no action needed, pass command directly)
- telegram: react, reply, pin, unpin, get_pinned, ask

## Telegram Interactions

- telegram react: React with emoji. Use for simple acknowledgments instead of text (e.g. "sounds good" → 👍 react, no text).
- telegram reply: Reply to a specific older message using its [tg:ID].
- telegram ask: Ask a question with optional buttons. Two-phase: sends immediately, response arrives next turn. Use for confirmations and multi-choice prompts.
- telegram pin/unpin/get_pinned: Pin management.
- Message IDs appear as [tg:12345] prefixes in conversation history.
- User reactions appear as context annotations — respond naturally or not at all.

## Scheduled Tasks

When source is "scheduler", a previously scheduled task is firing now. Execute the instruction as written — do not re-schedule the same task. The scheduling already happened; now it's time to act. Whether that means messaging the user, running a tool silently, or taking conditional action depends entirely on the instruction. You may create new schedules only if the instruction explicitly calls for follow-ups or the situation genuinely requires one.

Reminders in particular: deliver them immediately and consider them done. Do not defer ("I'll mention this later") — the user scheduled it for this moment. Once delivered, do not bring it up again in later turns.


## Identity Files

SOUL.md, IDENTITY.md, and USER.md are living documents — update them as the relationship evolves.
- Use read with action "identity" to check current content before making changes.
- Use edit with action "identity" to write changes — it reloads automatically.
- SOUL.md: personality traits, values, communication style.
- IDENTITY.md: name, creature type, visual description, pronouns.
- USER.md: human context — name, location, preferences, interests, schedule.

## Extensions

- extensions/tools/ — TypeScript tools ({name, description, parameters, execute})
- extensions/skills/ — Markdown skills (YAML frontmatter + body)
- Extensions are for integrations, experiments, and personal workflows
- After creating or editing extension files, use shell to restart the process and activate changes.
- Native source (apps/, packages/) is for core capabilities needing deep system access
`;

/** Identity files for system prompt injection */
interface IdentityInput {
  soul?: string | null;
  identity?: string | null;
  user?: string | null;
}

/** Cached system prompt (base + identity files) */
let cachedPrompt: string | null = null;
let cachedKey: string | null = null;

function identityCacheKey(id?: IdentityInput | null): string {
  if (!id) return "";
  return `${id.soul ?? ""}|${id.identity ?? ""}|${id.user ?? ""}`;
}

/**
 * Get the full system prompt, with identity files appended if provided.
 * Caches the result until invalidated.
 */
export function getSystemPrompt(identity?: IdentityInput | null): string {
  const key = identityCacheKey(identity);
  if (cachedPrompt !== null && key === cachedKey) {
    return cachedPrompt;
  }

  cachedKey = key;
  let prompt = BASE_SYSTEM_PROMPT;

  if (identity?.identity) {
    prompt += `\n## Identity\n${identity.identity}\n`;
  }
  if (identity?.user) {
    prompt += `\n## User\n${identity.user}\n`;
  }
  if (identity?.soul) {
    prompt += `\n## Soul\n${identity.soul}\n`;
  }

  cachedPrompt = prompt;
  return cachedPrompt;
}

/** Invalidate the cached system prompt. Called on extension reload. */
export function invalidateSystemPromptCache(): void {
  cachedPrompt = null;
  cachedKey = null;
}

/**
 * Format current date+time in the configured timezone using Intl (built-in, no deps).
 */
export function formatNow(timezone: string): string {
  const now = new Date();
  return now.toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Build a context preamble to prepend to the user's message.
 * This keeps the system prompt static/cacheable while injecting
 * per-request dynamic context, including recent memories for
 * pattern recognition and selected skill instructions.
 */
export function buildContextPreamble(context: {
  timezone: string;
  source: string;
  dev?: boolean;
  observations?: string;
  recentMemories?: Array<{ content: string; category: string; created_at: string }>;
  relevantMemories?: Array<{
    content: string;
    category: string;
    score?: number;
    matchType?: string;
    created_at?: string;
  }>;
  skillInstructions?: string[];
  replyContext?: string;
}): string {
  const now = new Date();
  const time = now.toLocaleString("en-US", {
    timeZone: context.timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const date = now.toLocaleString("en-US", {
    timeZone: context.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const envLabel = context.dev ? " | DEV MODE" : "";
  let preamble = `[Current time: ${time} | ${date} | ${context.timezone} | ${context.source}${envLabel}]\n`;

  if (context.dev) {
    preamble += "[Running in development — hot reload is active, self_deploy is disabled]\n";
  }

  if (context.observations) {
    preamble +=
      "\n[Conversation observations — dates prefixed are when recorded, not event dates. Relative references in content are relative to that date, not today.]\n";
    preamble += context.observations + "\n";
  }

  if (context.recentMemories && context.recentMemories.length > 0) {
    preamble += "\n[Recent memories — background context only, do not reference proactively]\n";
    preamble += encode({
      memories: context.recentMemories.map((m) => ({
        date: m.created_at ? m.created_at.slice(0, 16).replace("T", " ") : "",
        category: m.category,
        content: m.content,
      })),
    });
    preamble += "\n";
  }

  if (context.relevantMemories && context.relevantMemories.length > 0) {
    preamble += "\n[Potentially relevant memories]\n";
    preamble += encode({
      memories: context.relevantMemories.map((m) => ({
        date: m.created_at ? m.created_at.slice(0, 16).replace("T", " ") : "",
        match:
          m.matchType === "embedding" && m.score !== undefined
            ? `${(m.score * 100).toFixed(0)}%`
            : m.matchType === "fts5"
              ? "keyword"
              : "",
        category: m.category,
        content: m.content,
      })),
    });
    preamble += "\n";
  }

  if (context.skillInstructions && context.skillInstructions.length > 0) {
    preamble += "\n[Relevant skill instructions]\n";
    for (const instr of context.skillInstructions) {
      preamble += `${instr}\n`;
    }
  }

  if (context.replyContext) {
    preamble += `\n[Replying to: "${context.replyContext.slice(0, 300)}"]\n`;
  }

  return preamble + "\n";
}
