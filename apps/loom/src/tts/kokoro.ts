import { env } from '../env.js'

export interface TtsResult {
  audio: Buffer
  contentType: string
}

/**
 * Synthesize text to speech via Kokoro's OpenAI-compatible API.
 * Returns raw audio buffer (mp3). Disables streaming to get a single buffer.
 */
export async function synthesize(text: string, voice?: string): Promise<TtsResult> {
  const url = `${env.KOKORO_URL}/v1/audio/speech`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kokoro',
      input: text,
      voice: voice ?? env.KOKORO_VOICE,
      response_format: 'mp3',
      stream: false,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Kokoro TTS error ${res.status}: ${body}`)
  }

  const arrayBuf = await res.arrayBuffer()
  return {
    audio: Buffer.from(arrayBuf),
    contentType: res.headers.get('content-type') ?? 'audio/mpeg',
  }
}

/**
 * Synthesize text to speech and return Kokoro's streaming response directly.
 * Kokoro streams audio sentence-by-sentence as chunked MP3.
 */
export async function synthesizeStream(text: string, voice?: string): Promise<Response> {
  const url = `${env.KOKORO_URL}/v1/audio/speech`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kokoro',
      input: text,
      voice: voice ?? env.KOKORO_VOICE,
      response_format: 'mp3',
      stream: true,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Kokoro TTS error ${res.status}: ${body}`)
  }

  return res
}

/**
 * Extract only the narrative/spoken parts of a GM response.
 * Strips tables, code blocks, dice notation, stat blocks, and other
 * structured content that sounds terrible when read aloud.
 */
export function cleanTextForTts(text: string): string {
  return text
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove markdown tables (lines starting with |)
    .replace(/^\|.*\|$/gm, '')
    // Remove table separator lines (|---|---|)
    .replace(/^\s*[-|: ]+\s*$/gm, '')
    // Remove dice notation blocks like "Roll 2d6+3 (DC 15)"
    // but keep the surrounding narrative
    .replace(/\b\d+d\d+(?:\s*[+-]\s*\d+)?(?:\s*\([^)]*\))?/g, (match) => {
      // Keep short dice refs inline for natural speech
      return match.length < 10 ? match : ''
    })
    // Remove stat block patterns: "STR: 14 (+2)" etc
    .replace(/^[A-Z]{2,}:\s*\d+.*$/gm, '')
    // Remove markdown formatting
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    // Collapse resulting empty lines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
