import { Hono } from 'hono'
import { sql } from 'kysely'
import type { Env } from '../server.js'
import { VOICE_CATALOG, fetchAvailableVoices } from '../tts/voices.js'
import { synthesize, cleanTextForTts } from '../tts/kokoro.js'
import { env } from '../env.js'

export const settingsRoutes = new Hono<Env>()

// --- Voice catalog ---

settingsRoutes.get('/voices', async (c) => {
  const liveVoices = env.TTS_ENABLED ? await fetchAvailableVoices() : []
  const catalogIds = new Set(VOICE_CATALOG.map((v) => v.id))

  // Any voices in Kokoro not in our catalog are custom/saved blends
  const customVoices = liveVoices
    .filter((id) => !catalogIds.has(id) && !id.includes('v0'))
    .map((id) => ({
      id,
      name: id,
      gender: id.includes('f_') ? 'female' as const : 'male' as const,
      accent: 'Custom',
      grade: '-',
    }))

  return c.json({
    voices: [...VOICE_CATALOG, ...customVoices],
    ttsEnabled: env.TTS_ENABLED,
  })
})

// --- Voice config (stored in settings table) ---

const VOICE_CONFIG_KEY = 'voice_config'

export interface VoiceConfig {
  defaultVoice: string
  npcVoices: Record<string, string>
  savedBlends?: Array<{ name: string; expression: string }>
}

const DEFAULT_CONFIG: VoiceConfig = {
  defaultVoice: 'af_heart',
  npcVoices: {},
  savedBlends: [],
}

settingsRoutes.get('/voice-config', async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', VOICE_CONFIG_KEY)
    .executeTakeFirst()

  const config: VoiceConfig = row ? JSON.parse(row.value) : DEFAULT_CONFIG
  return c.json(config)
})

settingsRoutes.put('/voice-config', async (c) => {
  const db = c.get('db')
  const body = await c.req.json<VoiceConfig>()

  const config: VoiceConfig = {
    defaultVoice: body.defaultVoice || DEFAULT_CONFIG.defaultVoice,
    npcVoices: body.npcVoices || {},
    savedBlends: body.savedBlends || [],
  }

  await db
    .insertInto('settings')
    .values({
      key: VOICE_CONFIG_KEY,
      value: JSON.stringify(config),
    })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({
        value: JSON.stringify(config),
        updated_at: sql`datetime('now')`,
      }),
    )
    .execute()

  return c.json(config)
})

// --- Preview (blend expressions work inline as voice param) ---

settingsRoutes.post('/voice-preview', async (c) => {
  if (!env.TTS_ENABLED) {
    return c.json({ error: 'TTS is not enabled' }, 400)
  }

  const { text, voice } = await c.req.json<{ text?: string; voice: string }>()
  const sample = text?.trim() || 'You enter the tavern. A fire crackles in the hearth, and the innkeeper looks up with a crooked smile.'
  const cleaned = cleanTextForTts(sample)

  try {
    const result = await synthesize(cleaned, voice)
    return new Response(result.audio, {
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 502)
  }
})

// --- Characters from knowledge graph (for NPC voice assignment) ---

settingsRoutes.get('/characters', async (c) => {
  const db = c.get('db')
  const names = new Set<string>()

  // 1. From knowledge graph
  try {
    const nodes = await db
      .selectFrom('graph_nodes')
      .select(['name', 'node_type'])
      .where('node_type', 'in', ['person', 'creature', 'npc', 'character'])
      .orderBy('name', 'asc')
      .execute()
    for (const n of nodes) {
      // Capitalize: "cutiepie" → "Cutiepie", "mrs. hargrove" → "Mrs. Hargrove"
      const capitalized = n.name.replace(/\b\w/g, (c) => c.toUpperCase())
      names.add(capitalized)
    }
    console.log(`[characters] graph: ${nodes.length} nodes`)
  } catch (err) {
    console.log(`[characters] graph query failed:`, err)
  }

  // 2. From recent assistant messages — extract "Name:" section headers
  try {
    const msgs = await db
      .selectFrom('messages')
      .select('content')
      .where('role', '=', 'assistant')
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute()
    console.log(`[characters] scanned ${msgs.length} messages`)
    const namePattern = /^([A-Z][a-zA-Z]+):/gm
    for (const msg of msgs) {
      for (const match of msg.content.matchAll(namePattern)) {
        const name = match[1]
        if (!['Roll', 'Note', 'Armor', 'Rules', 'Summary', 'DC', 'HP', 'AC'].includes(name)) {
          names.add(name)
        }
      }
    }
  } catch (err) {
    console.log(`[characters] messages query failed:`, err)
  }

  console.log(`[characters] result: ${[...names].join(', ') || '(none)'}`)

  return c.json({ characters: [...names].sort() })
})
