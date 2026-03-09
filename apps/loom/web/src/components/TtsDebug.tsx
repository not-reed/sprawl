import { useState, useRef, useEffect } from 'react'

interface Segment {
  speaker: string
  text: string
  voice?: string
}

interface Timing {
  speaker: string
  voice: string
  chars: number
  ms: number
}

export function TtsDebug() {
  const [rawText, setRawText] = useState('')
  const [segments, setSegments] = useState<Segment[]>([])
  const [scriptifyMs, setScriptifyMs] = useState<number | null>(null)
  const [model, setModel] = useState('')
  const [skipped, setSkipped] = useState(false)
  const [loading, setLoading] = useState(false)
  const [synthesizing, setSynthesizing] = useState(false)
  const [timings, setTimings] = useState<Timing[]>([])
  const [error, setError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [voiceConfig, setVoiceConfig] = useState<{ defaultVoice: string; npcVoices: Record<string, string> }>({ defaultVoice: '', npcVoices: {} })
  const [characters, setCharacters] = useState<string[]>([])

  useEffect(() => {
    Promise.all([
      fetch('/api/settings/voices').then((r) => r.json()),
      fetch('/api/settings/voice-config').then((r) => r.json()),
      fetch('/api/settings/characters').then((r) => r.json()).catch(() => ({ characters: [] })),
    ]).then(([_v, vc, ch]) => {
      setVoiceConfig({ defaultVoice: vc.defaultVoice ?? '', npcVoices: vc.npcVoices ?? {} })
      setCharacters(ch.characters ?? [])
    })
  }, [])

  async function handleScriptify() {
    if (!rawText.trim()) return
    setLoading(true)
    setError('')
    setTimings([])
    try {
      const res = await fetch('/api/debug/scriptify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: rawText }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      const data = await res.json()
      setSegments(data.segments)
      setScriptifyMs(data.scriptifyMs)
      setModel(data.model)
      setSkipped(data.skipped)
    } catch (err) {
      setError(`Scriptify failed: ${err}`)
    } finally {
      setLoading(false)
    }
  }

  async function handleSynthesize() {
    if (!segments.length) return
    setSynthesizing(true)
    setError('')
    setTimings([])
    try {
      const res = await fetch('/api/debug/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments }),
      })
      if (!res.ok) throw new Error(`${res.status}`)

      const timingHeader = res.headers.get('X-TTS-Timings')
      if (timingHeader) {
        setTimings(JSON.parse(timingHeader))
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      if (audioRef.current) {
        audioRef.current.src = url
        audioRef.current.play()
      }
    } catch (err) {
      setError(`Synthesize failed: ${err}`)
    } finally {
      setSynthesizing(false)
    }
  }

  function updateSegment(idx: number, field: keyof Segment, value: string) {
    setSegments((prev) => prev.map((s, i) => i === idx ? { ...s, [field]: value } : s))
  }

  function removeSegment(idx: number) {
    setSegments((prev) => prev.filter((_, i) => i !== idx))
  }

  function addSegment() {
    setSegments((prev) => [...prev, { speaker: 'NARRATOR', text: '' }])
  }

  return (
    <div className="debug-page">
      <h2>TTS Debug</h2>

      <div className="debug-section">
        <h3>1. Raw Story Text</h3>
        <textarea
          className="debug-textarea"
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder="Paste raw GM/story text here..."
          rows={10}
        />
        <button
          className="btn btn-accent"
          onClick={handleScriptify}
          disabled={loading || !rawText.trim()}
        >
          {loading ? 'Running scriptify...' : 'Scriptify'}
        </button>
      </div>

      {error && <div className="debug-error">{error}</div>}

      {segments.length > 0 && (
        <div className="debug-section">
          <h3>2. Segments</h3>
          {scriptifyMs !== null && (
            <div className="debug-meta">
              Scriptify: {scriptifyMs}ms | Model: {model}
              {skipped && ' | (skipped — text too short or no patterns)'}
            </div>
          )}

          <div className="debug-segments">
            {segments.map((seg, i) => (
              <div key={i} className="debug-segment">
                <div className="debug-segment-header">
                  <input
                    className="debug-speaker-input"
                    value={seg.speaker}
                    onChange={(e) => updateSegment(i, 'speaker', e.target.value)}
                  />
                  <input
                    className="debug-voice-input"
                    value={seg.voice ?? ''}
                    onChange={(e) => updateSegment(i, 'voice', e.target.value || undefined as any)}
                    placeholder="auto"
                    title="Voice override (leave blank for auto)"
                  />
                  <button className="btn btn-sm btn-danger" onClick={() => removeSegment(i)}>×</button>
                </div>
                <textarea
                  className="debug-segment-text"
                  value={seg.text}
                  onChange={(e) => updateSegment(i, 'text', e.target.value)}
                  rows={3}
                />
              </div>
            ))}
            <button className="btn btn-sm" onClick={addSegment}>+ Add Segment</button>
          </div>

          <button
            className="btn btn-accent"
            onClick={handleSynthesize}
            disabled={synthesizing || segments.every((s) => !s.text.trim())}
          >
            {synthesizing ? 'Synthesizing...' : 'Synthesize & Play'}
          </button>
        </div>
      )}

      {segments.length > 0 && (() => {
        const uniqueSpeakers = [...new Set(segments.map((s) => s.speaker))].filter((s) => s !== 'NARRATOR')
        const allChars = [...new Set([...characters, ...uniqueSpeakers])]
        if (allChars.length === 0) return null

        const AUTO_VOICES = [
          'am_fenrir', 'bf_emma', 'am_puck', 'af_bella', 'bm_george',
          'af_nicole', 'am_michael', 'bf_isabella', 'bm_fable', 'af_kore',
        ]
        let autoIdx = 0
        const autoMap = new Map<string, string>()
        for (const name of uniqueSpeakers) {
          if (!voiceConfig.npcVoices[name] && !autoMap.has(name)) {
            autoMap.set(name, AUTO_VOICES[autoIdx % AUTO_VOICES.length])
            autoIdx++
          }
        }

        return (
          <div className="debug-section">
            <h3>Characters & Voices</h3>
            <div className="debug-meta">
              NARRATOR = {voiceConfig.defaultVoice || '(default)'}
            </div>
            <table className="debug-table">
              <thead>
                <tr>
                  <th>Character</th>
                  <th>Assigned Voice</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {allChars.map((name) => {
                  const configured = voiceConfig.npcVoices[name]
                  const auto = autoMap.get(name)
                  const inSegments = uniqueSpeakers.includes(name)
                  return (
                    <tr key={name}>
                      <td>
                        {name}
                        {inSegments && <span className="debug-badge-active" title="In current segments"> *</span>}
                      </td>
                      <td>
                        <code>{configured ?? auto ?? '-'}</code>
                      </td>
                      <td>
                        {configured ? (
                          <span style={{ color: 'var(--green)' }}>configured</span>
                        ) : auto ? (
                          <span style={{ color: 'var(--orange)' }}>auto-assigned</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>no voice</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="debug-meta" style={{ marginTop: '0.5rem' }}>
              Configure voices on the <a href="/voices" style={{ color: 'var(--accent)' }}>Voices page</a>
            </div>
          </div>
        )
      })()}

      {timings.length > 0 && (
        <div className="debug-section">
          <h3>3. Synthesis Timings</h3>
          <table className="debug-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Speaker</th>
                <th>Voice</th>
                <th>Chars</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {timings.map((t, i) => (
                <tr key={i}>
                  <td>{i}</td>
                  <td>{t.speaker}</td>
                  <td><code>{t.voice}</code></td>
                  <td>{t.chars}</td>
                  <td>{(t.ms / 1000).toFixed(1)}s</td>
                </tr>
              ))}
              <tr className="debug-table-total">
                <td colSpan={4}>Total</td>
                <td>{(timings.reduce((s, t) => s + t.ms, 0) / 1000).toFixed(1)}s</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <audio ref={audioRef} controls className="debug-audio" />
    </div>
  )
}
