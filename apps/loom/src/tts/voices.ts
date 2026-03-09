import { env } from '../env.js'

export interface Voice {
  id: string
  name: string
  gender: 'female' | 'male'
  accent: string
  grade: string
}

// Static catalog with quality grades (Kokoro API doesn't expose these)
export const VOICE_CATALOG: Voice[] = [
  // American English - Female
  { id: 'af_heart', name: 'Heart', gender: 'female', accent: 'American', grade: 'A' },
  { id: 'af_bella', name: 'Bella', gender: 'female', accent: 'American', grade: 'A-' },
  { id: 'af_nicole', name: 'Nicole', gender: 'female', accent: 'American', grade: 'B-' },
  { id: 'af_aoede', name: 'Aoede', gender: 'female', accent: 'American', grade: 'C+' },
  { id: 'af_kore', name: 'Kore', gender: 'female', accent: 'American', grade: 'C+' },
  { id: 'af_sarah', name: 'Sarah', gender: 'female', accent: 'American', grade: 'C+' },
  { id: 'af_alloy', name: 'Alloy', gender: 'female', accent: 'American', grade: 'C' },
  { id: 'af_nova', name: 'Nova', gender: 'female', accent: 'American', grade: 'C' },
  { id: 'af_jessica', name: 'Jessica', gender: 'female', accent: 'American', grade: 'D' },
  { id: 'af_river', name: 'River', gender: 'female', accent: 'American', grade: 'D' },
  { id: 'af_sky', name: 'Sky', gender: 'female', accent: 'American', grade: 'C-' },

  // American English - Male
  { id: 'am_fenrir', name: 'Fenrir', gender: 'male', accent: 'American', grade: 'C+' },
  { id: 'am_michael', name: 'Michael', gender: 'male', accent: 'American', grade: 'C+' },
  { id: 'am_puck', name: 'Puck', gender: 'male', accent: 'American', grade: 'C+' },
  { id: 'am_echo', name: 'Echo', gender: 'male', accent: 'American', grade: 'D' },
  { id: 'am_eric', name: 'Eric', gender: 'male', accent: 'American', grade: 'D' },
  { id: 'am_liam', name: 'Liam', gender: 'male', accent: 'American', grade: 'D' },
  { id: 'am_onyx', name: 'Onyx', gender: 'male', accent: 'American', grade: 'D' },
  { id: 'am_adam', name: 'Adam', gender: 'male', accent: 'American', grade: 'F+' },

  // British English - Female
  { id: 'bf_emma', name: 'Emma', gender: 'female', accent: 'British', grade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', gender: 'female', accent: 'British', grade: 'C' },
  { id: 'bf_alice', name: 'Alice', gender: 'female', accent: 'British', grade: 'D' },
  { id: 'bf_lily', name: 'Lily', gender: 'female', accent: 'British', grade: 'D' },

  // British English - Male
  { id: 'bm_george', name: 'George', gender: 'male', accent: 'British', grade: 'C' },
  { id: 'bm_fable', name: 'Fable', gender: 'male', accent: 'British', grade: 'C' },
  { id: 'bm_daniel', name: 'Daniel', gender: 'male', accent: 'British', grade: 'D' },
  { id: 'bm_lewis', name: 'Lewis', gender: 'male', accent: 'British', grade: 'D+' },

  // French
  { id: 'ff_siwis', name: 'Siwis', gender: 'female', accent: 'French', grade: 'B-' },
]

/**
 * Build a Kokoro blend expression from voice+weight pairs.
 * e.g. [{ id: 'af_bella', weight: 2 }, { id: 'af_sky', weight: 1 }]
 * → "af_bella(2)+af_sky(1)"
 * This is passed directly as the `voice` parameter — no save/combine needed.
 */
export function buildBlendExpression(voices: Array<{ id: string; weight: number }>): string {
  return voices.map((v) => `${v.id}(${v.weight})`).join('+')
}

/** Fetch live voice list from Kokoro to detect custom/saved voices. */
export async function fetchAvailableVoices(): Promise<string[]> {
  try {
    const res = await fetch(`${env.KOKORO_URL}/v1/audio/voices`)
    if (!res.ok) return VOICE_CATALOG.map((v) => v.id)
    const data = await res.json() as { voices: string[] }
    return data.voices
  } catch {
    return VOICE_CATALOG.map((v) => v.id)
  }
}
