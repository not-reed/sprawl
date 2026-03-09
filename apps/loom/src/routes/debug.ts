import { Hono } from 'hono'
import type { Env } from '../server.js'
import { scriptify, parseSegments } from '../tts/scriptify.js'
import { synthesize, cleanTextForTts } from '../tts/kokoro.js'
import { env } from '../env.js'

export const debugRoutes = new Hono<Env>()

/** POST /api/debug/scriptify — run scriptify on raw text, return segments */
debugRoutes.post('/scriptify', async (c) => {
  const db = c.get('db')
  const { text } = await c.req.json<{ text: string }>()
  if (!text?.trim()) return c.json({ error: 'text is required' }, 400)

  const t0 = performance.now()
  const segments = await scriptify(text, db)
  const ms = performance.now() - t0

  return c.json({
    segments: segments ?? [{ speaker: 'NARRATOR', text: cleanTextForTts(text) }],
    scriptifyMs: Math.round(ms),
    model: env.MEMORY_WORKER_MODEL ?? env.OPENROUTER_MODEL,
    skipped: segments === null,
  })
})

/** POST /api/debug/parse-only — parse already-tagged text (no LLM call) */
debugRoutes.post('/parse-only', async (c) => {
  const { text } = await c.req.json<{ text: string }>()
  if (!text?.trim()) return c.json({ error: 'text is required' }, 400)

  const segments = parseSegments(text)
  return c.json({ segments })
})

/** POST /api/debug/synthesize-segments — synthesize segments array, return streaming audio */
debugRoutes.post('/synthesize', async (c) => {
  const db = c.get('db')
  const { segments } = await c.req.json<{ segments: Array<{ speaker: string; text: string; voice?: string }> }>()
  if (!segments?.length) return c.json({ error: 'segments required' }, 400)

  // Load voice config for auto-assignment
  let defaultVoice = env.KOKORO_VOICE
  const npcVoices: Record<string, string> = {}
  try {
    const row = await db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'voice_config')
      .executeTakeFirst()
    if (row) {
      const config = JSON.parse(row.value)
      defaultVoice = config.defaultVoice ?? defaultVoice
      Object.assign(npcVoices, config.npcVoices ?? {})
    }
  } catch {}

  const AUTO_VOICES = [
    'am_fenrir', 'bf_emma', 'am_puck', 'af_bella', 'bm_george',
    'af_nicole', 'am_michael', 'bf_isabella', 'bm_fable', 'af_kore',
  ]
  const autoAssigned = new Map<string, string>()
  let autoIdx = 0

  const timings: Array<{ speaker: string; voice: string; chars: number; ms: number }> = []
  const buffers: Buffer[] = []

  for (const seg of segments) {
    let voice = seg.voice
    if (!voice) {
      if (seg.speaker === 'NARRATOR') {
        voice = defaultVoice
      } else {
        voice = npcVoices[seg.speaker]
        if (!voice) {
          if (!autoAssigned.has(seg.speaker)) {
            autoAssigned.set(seg.speaker, AUTO_VOICES[autoIdx % AUTO_VOICES.length])
            autoIdx++
          }
          voice = autoAssigned.get(seg.speaker)!
        }
      }
    }

    const t0 = performance.now()
    const result = await synthesize(seg.text, voice)
    const ms = performance.now() - t0
    timings.push({ speaker: seg.speaker, voice, chars: seg.text.length, ms: Math.round(ms) })
    buffers.push(result.audio)
  }

  const combined = Buffer.concat(buffers)

  // Return timings as a header so the client can display them
  return new Response(combined, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'X-TTS-Timings': JSON.stringify(timings),
      'Cache-Control': 'no-store',
    },
  })
})
