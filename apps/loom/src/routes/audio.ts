import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Env } from '../server.js'
import type { Database } from '../db/schema.js'
import { synthesize, synthesizeStream, cleanTextForTts } from '../tts/kokoro.js'
import { scriptify, type Segment } from '../tts/scriptify.js'
import { env } from '../env.js'

// In-memory audio cache with TTL cleanup
const audioCache = new Map<string, { audio: Buffer; contentType: string; expires: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

function cleanExpired() {
  const now = Date.now()
  for (const [id, entry] of audioCache) {
    if (entry.expires < now) audioCache.delete(id)
  }
}

function elapsed(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`
}

export const audioRoutes = new Hono<Env>()

/** GET /api/audio/:id — serve cached audio */
audioRoutes.get('/:id', (c) => {
  const entry = audioCache.get(c.req.param('id'))
  if (!entry || entry.expires < Date.now()) {
    audioCache.delete(c.req.param('id'))
    return c.json({ error: 'Not found or expired' }, 404)
  }

  return new Response(entry.audio, {
    headers: {
      'Content-Type': entry.contentType,
      'Cache-Control': 'no-store',
    },
  })
})

/** Load full voice config from settings table. */
async function getVoiceConfig(db: Kysely<Database>): Promise<{ defaultVoice: string; npcVoices: Record<string, string> }> {
  try {
    const row = await db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'voice_config')
      .executeTakeFirst()
    if (row) {
      const config = JSON.parse(row.value)
      return {
        defaultVoice: config.defaultVoice ?? env.KOKORO_VOICE,
        npcVoices: config.npcVoices ?? {},
      }
    }
  } catch {}
  return { defaultVoice: env.KOKORO_VOICE, npcVoices: {} }
}

// Fallback voices for auto-assigning to NPC characters that aren't in voice_config.
// Picks from distinct-sounding voices to maximize contrast with narrator.
const AUTO_VOICES = [
  'am_fenrir', 'bf_emma', 'am_puck', 'af_bella', 'bm_george',
  'af_nicole', 'am_michael', 'bf_isabella', 'bm_fable', 'af_kore',
]

/** Resolve a speaker to a Kokoro voice ID. */
function buildVoiceResolver(defaultVoice: string, npcVoices: Record<string, string>) {
  const autoAssigned = new Map<string, string>()
  let autoIdx = 0
  return (speaker: string): string => {
    if (speaker === 'NARRATOR') return defaultVoice
    if (npcVoices[speaker]) return npcVoices[speaker]
    if (!autoAssigned.has(speaker)) {
      autoAssigned.set(speaker, AUTO_VOICES[autoIdx % AUTO_VOICES.length])
      autoIdx++
    }
    return autoAssigned.get(speaker)!
  }
}

/** Synthesize each segment with its mapped voice (parallel). */
async function synthesizeSegments(
  segments: Segment[],
  defaultVoice: string,
  npcVoices: Record<string, string>,
): Promise<Buffer[]> {
  const resolveVoice = buildVoiceResolver(defaultVoice, npcVoices)
  const t0 = performance.now()

  const promises = segments.map((seg, i) => {
    const voice = resolveVoice(seg.speaker)
    console.log(`[tts] segment ${i}: [${seg.speaker}] → voice=${voice} (${seg.text.length} chars)`)
    const segStart = performance.now()
    return synthesize(seg.text, voice).then((r) => {
      console.log(`[tts] segment ${i} done in ${elapsed(segStart)}`)
      return r
    })
  })
  const results = await Promise.all(promises)
  console.log(`[tts] all ${segments.length} segments synthesized in ${elapsed(t0)}`)
  return results.map((r) => r.audio)
}

/**
 * Generate TTS for text, cache it, return the audio ID.
 * Returns null if TTS is disabled or fails.
 */
export async function generateAudio(
  text: string,
  db: Kysely<Database>,
  voice?: string,
): Promise<string | null> {
  if (!env.TTS_ENABLED) return null
  const t0 = performance.now()
  console.log(`[tts] generateAudio start (${text.length} chars, scriptify=${env.TTS_SCRIPTIFY})`)

  const voiceConfig = await getVoiceConfig(db)
  const defaultVoice = voice ?? voiceConfig.defaultVoice

  try {
    let audioBuffers: Buffer[]

    if (env.TTS_SCRIPTIFY) {
      const scriptStart = performance.now()
      const segments = await scriptify(text, db)
      console.log(`[tts] scriptify: ${elapsed(scriptStart)} → ${segments ? segments.length + ' segments' : 'null (fallback)'}`)

      if (segments) {
        audioBuffers = await synthesizeSegments(segments, defaultVoice, voiceConfig.npcVoices)
      } else {
        const cleaned = cleanTextForTts(text)
        if (!cleaned) return null
        const synthStart = performance.now()
        const result = await synthesize(cleaned, defaultVoice)
        console.log(`[tts] single-voice synthesize: ${elapsed(synthStart)}`)
        audioBuffers = [result.audio]
      }
    } else {
      const cleaned = cleanTextForTts(text)
      if (!cleaned) return null
      const synthStart = performance.now()
      const result = await synthesize(cleaned, defaultVoice)
      console.log(`[tts] single-voice synthesize: ${elapsed(synthStart)}`)
      audioBuffers = [result.audio]
    }

    const combined = Buffer.concat(audioBuffers)
    const id = randomUUID()
    cleanExpired()
    audioCache.set(id, {
      audio: combined,
      contentType: 'audio/mpeg',
      expires: Date.now() + CACHE_TTL_MS,
    })
    console.log(`[tts] generateAudio done in ${elapsed(t0)}, cached as ${id} (${combined.length} bytes)`)
    return id
  } catch (err) {
    console.error(`[tts] generateAudio failed after ${elapsed(t0)}:`, err)
    return null
  }
}

/**
 * Stream TTS audio directly from Kokoro to the client.
 * When scriptify is enabled, runs scriptify + parallel synthesis then concatenates.
 * When scriptify is off, streams directly from Kokoro sentence-by-sentence.
 */
export async function streamAudioResponse(
  text: string,
  db: Kysely<Database>,
  voice?: string,
): Promise<Response | null> {
  if (!env.TTS_ENABLED) return null
  const t0 = performance.now()
  console.log(`[tts:stream] start (${text.length} chars, scriptify=${env.TTS_SCRIPTIFY})`)

  const voiceConfig = await getVoiceConfig(db)
  const defaultVoice = voice ?? voiceConfig.defaultVoice

  if (env.TTS_SCRIPTIFY) {
    const scriptStart = performance.now()
    const segments = await scriptify(text, db)
    console.log(`[tts:stream] scriptify: ${elapsed(scriptStart)} → ${segments ? segments.length + ' segments' : 'null (fallback)'}`)

    if (segments) {
      const audioBuffers = await synthesizeSegments(segments, defaultVoice, voiceConfig.npcVoices)
      const combined = Buffer.concat(audioBuffers)
      console.log(`[tts:stream] scriptify path done in ${elapsed(t0)} (${combined.length} bytes)`)
      return new Response(combined, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-store',
        },
      })
    }
  }

  // Single-voice streaming path
  const cleaned = cleanTextForTts(text)
  if (!cleaned) return null

  console.log(`[tts:stream] kokoro stream request start`)
  const kokoroStart = performance.now()
  const kokoroRes = await synthesizeStream(cleaned, defaultVoice)
  console.log(`[tts:stream] kokoro first byte: ${elapsed(kokoroStart)}`)
  if (!kokoroRes.body) return null

  return new Response(kokoroRes.body as ReadableStream, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-store',
    },
  })
}
