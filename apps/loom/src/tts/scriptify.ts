import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { trackUsage } from '../db/queries.js'
import { cleanTextForTts } from './kokoro.js'
import { env } from '../env.js'

export interface Segment {
  speaker: string
  text: string
}

const NEEDS_SCRIPTIFY = /[|#*]|\d+d\d+|```|^[-*]\s|^\w+:/m

const SYSTEM_PROMPT = `You adapt tabletop RPG game master text into a radio play script for multi-voice text-to-speech performance.

Think of yourself as a script adapter for an audio drama. The GM wrote the story. Your job is to turn it into something that sounds great when performed aloud by voice actors.

## How the input works
The GM addresses player characters by name with "CharacterName:" sections. This is the narrator speaking TO that character, not the character speaking. Only text inside quotation marks spoken by an NPC is actual dialogue.

## Speaker tags
- [NARRATOR] — all narration, description, game instructions, and addressing player characters
- [NPC Name] — only for actual quoted dialogue from named NPCs

## Example

Input:
Whiskers: The crystal pulses warm in your jaws. Mrs. Hargrove gasps, "It's alive!"
Shadow: You spot the entrance. "Follow me," hisses the old rat.

Output:
[NARRATOR]
Whiskers. The crystal pulses warm in your jaws.
[NARRATOR]
Mrs. Hargrove gasps.
[Mrs. Hargrove]
It's alive!
[NARRATOR]
Shadow. You spot the entrance.
[Old Rat]
Follow me.
[NARRATOR]
Hisses the old rat.

## Adaptation rules
- Say the character's name clearly when the narrator addresses them (replace "Name:" with "Name." or "Name," as a spoken address)
- Break long narration into shorter sentences. Vary rhythm. Let dramatic moments breathe.
- NEVER use em dashes, en dashes, or hyphens as punctuation. Use commas, periods, or semicolons.
- Expand dice notation to spoken words: "2d6+3" becomes "two six sided dice plus three", "DC 15" becomes "difficulty fifteen"
- Convert markdown (tables, bullets, bold, headers) into flowing spoken prose
- Strip or briefly vocalize mechanical instructions (armor notes, roll instructions)
- Add natural pauses through punctuation: commas, ellipses, sentence breaks
- Do NOT invent content that wasn't in the original
- Do NOT add stage directions, sound effects, or meta-commentary
- Keep roughly the same length as the original

Return ONLY the tagged script. No code fences, no explanation.`

/**
 * Rewrite GM text into speaker-tagged segments for multi-voice TTS.
 * Returns null if text doesn't need rewriting or on failure (caller falls back to single-voice).
 */
export async function scriptify(text: string, db: Kysely<Database>): Promise<Segment[] | null> {
  if (text.length < 80 || !NEEDS_SCRIPTIFY.test(text)) return null

  const model = env.MEMORY_WORKER_MODEL ?? env.OPENROUTER_MODEL
  console.log(`[scriptify] starting, model=${model}, input=${text.length} chars, system_prompt=${SYSTEM_PROMPT.length} chars`)

  try {
    const fetchStart = performance.now()
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
        max_tokens: 2048,
        reasoning: { max_tokens: 1 },
      }),
    })
    const fetchMs = (performance.now() - fetchStart).toFixed(0)

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      console.error(`[scriptify] API error ${response.status} after ${fetchMs}ms: ${body}`)
      return null
    }

    const parseStart = performance.now()
    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const parseMs = (performance.now() - parseStart).toFixed(0)

    const content = data.choices[0]?.message?.content?.trim()
    if (!content) return null

    console.log(`[scriptify] fetch=${fetchMs}ms, parse=${parseMs}ms, usage=${JSON.stringify(data.usage)}`)
    console.log(`[scriptify] LLM output:\n${content}`)

    await trackUsage(db, {
      model,
      input_tokens: data.usage?.prompt_tokens ?? null,
      output_tokens: data.usage?.completion_tokens ?? null,
      cost_usd: null,
      source: 'loom:scriptify',
    }).catch(() => {})

    const segments = parseSegments(content)
    console.log(`[scriptify] parsed ${segments.length} segments:`, segments.map(s => `[${s.speaker}] ${s.text.slice(0, 60)}...`))
    return segments
  } catch (err) {
    console.error('Scriptify failed:', err)
    return null
  }
}

/** Parse speaker-tagged LLM output into segments.
 *  Handles both formats:
 *    [Speaker]\nText on next line
 *    [Speaker] Text on same line
 */
export function parseSegments(tagged: string): Segment[] {
  const segments: Segment[] = []
  // Match [Speaker] at line start, with text either after whitespace on same line or on following lines
  const tagPattern = /^\[([^\]]+)\][ \t]*/gm
  let lastSpeaker: string | null = null
  let lastIndex = 0

  for (const match of tagged.matchAll(tagPattern)) {
    // Capture text between previous tag's content start and this tag
    if (lastSpeaker !== null) {
      const text = cleanTextForTts(tagged.slice(lastIndex, match.index).trim())
      if (text) segments.push({ speaker: lastSpeaker, text })
    }
    lastSpeaker = match[1].trim()
    lastIndex = match.index + match[0].length
  }

  // Capture final segment
  if (lastSpeaker !== null) {
    const text = cleanTextForTts(tagged.slice(lastIndex).trim())
    if (text) segments.push({ speaker: lastSpeaker, text })
  }

  return segments.length ? segments : [{ speaker: 'NARRATOR', text: cleanTextForTts(tagged) }]
}
