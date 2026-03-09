import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import type { Env } from '../server.js'
import { processMessage } from '../agent.js'
import { getSession, getMessages } from '../db/queries.js'
import { streamAudioResponse } from './audio.js'

export const chatRoutes = new Hono<Env>()

// Pending stream requests: the chat route stores text here, the stream endpoint consumes it
const pendingStreams = new Map<string, { text: string; db: any; expires: number }>()
const PENDING_TTL_MS = 30_000

function cleanPending() {
  const now = Date.now()
  for (const [id, entry] of pendingStreams) {
    if (entry.expires < now) pendingStreams.delete(id)
  }
}

chatRoutes.post('/', async (c) => {
  const db = c.get('db')
  const { sessionId, message } = await c.req.json<{ sessionId: string; message: string }>()

  if (!sessionId || !message?.trim()) {
    return c.json({ error: 'sessionId and message are required' }, 400)
  }

  return streamSSE(c, async (stream) => {
    try {
      const t0 = performance.now()
      const result = await processMessage(db, sessionId, message, {
        onDelta: async (text) => {
          await stream.writeSSE({ data: JSON.stringify({ type: 'delta', text }) })
        },
      })
      const llmMs = (performance.now() - t0).toFixed(0)
      console.log(`[chat] LLM done in ${llmMs}ms (${result.responseText.length} chars)`)
      await stream.writeSSE({ data: JSON.stringify({ type: 'done', text: result.responseText }) })

      // TTS: issue a stream token so the client can fetch audio immediately
      cleanPending()
      const streamId = randomUUID()
      pendingStreams.set(streamId, { text: result.responseText, db, expires: Date.now() + PENDING_TTL_MS })
      console.log(`[chat] sending audio stream URL: /api/chat/tts-stream/${streamId}`)
      await stream.writeSSE({
        data: JSON.stringify({ type: 'audio', url: `/api/chat/tts-stream/${streamId}` }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', error: msg }) })
    }
  })
})

/** GET /api/chat/tts-stream/:id — stream audio from Kokoro on demand */
chatRoutes.get('/tts-stream/:id', async (c) => {
  const t0 = performance.now()
  const id = c.req.param('id')
  const pending = pendingStreams.get(id)
  pendingStreams.delete(id)

  if (!pending || pending.expires < Date.now()) {
    console.log(`[chat] tts-stream/${id}: not found or expired`)
    return c.json({ error: 'Not found or expired' }, 404)
  }

  console.log(`[chat] tts-stream/${id}: client fetched, starting TTS pipeline`)
  try {
    const res = await streamAudioResponse(pending.text, pending.db)
    if (!res) return c.json({ error: 'TTS unavailable' }, 503)
    console.log(`[chat] tts-stream/${id}: response ready in ${(performance.now() - t0).toFixed(0)}ms`)
    return res
  } catch (err) {
    console.error(`[chat] tts-stream/${id}: failed after ${(performance.now() - t0).toFixed(0)}ms:`, err)
    return c.json({ error: 'TTS failed' }, 500)
  }
})

/** POST /api/chat/tts — register text for streaming, return a stream URL */
chatRoutes.post('/tts', async (c) => {
  const db = c.get('db')
  const { text } = await c.req.json<{ text: string }>()
  if (!text?.trim()) return c.json({ error: 'text is required' }, 400)

  cleanPending()
  const streamId = randomUUID()
  pendingStreams.set(streamId, { text, db, expires: Date.now() + PENDING_TTL_MS })
  return c.json({ url: `/api/chat/tts-stream/${streamId}` })
})

chatRoutes.get('/:sessionId/history', async (c) => {
  const db = c.get('db')
  const session = await getSession(db, c.req.param('sessionId'))
  if (!session) return c.json({ error: 'Not found' }, 404)

  const messages = await getMessages(db, session.conversation_id)
  return c.json({ messages })
})
