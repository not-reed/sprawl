import { useEffect, useState, useRef } from 'react'
import { api } from '../lib/api'
import type { Voice, VoiceConfig } from '../lib/types'

function buildBlendExpression(voices: Array<{ id: string; weight: number }>): string {
  return voices.map((v) => `${v.id}(${v.weight})`).join('+')
}

export function VoiceSettings() {
  const [voices, setVoices] = useState<Voice[]>([])
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [config, setConfig] = useState<VoiceConfig>({
    defaultVoice: 'af_heart', npcVoices: {}, savedBlends: [],
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [previewText, setPreviewText] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // NPC state
  const [npcName, setNpcName] = useState('')
  const [npcVoice, setNpcVoice] = useState('')
  const [characters, setCharacters] = useState<string[]>([])

  // Blend state
  const [blendSlots, setBlendSlots] = useState<Array<{ id: string; weight: number }>>([
    { id: '', weight: 1 },
    { id: '', weight: 1 },
  ])
  const [blendName, setBlendName] = useState('')

  // Catalog filters
  const [catalogSearch, setCatalogSearch] = useState('')
  const [catalogGender, setCatalogGender] = useState('')
  const [catalogAccent, setCatalogAccent] = useState('')

  useEffect(() => {
    Promise.all([
      api.getVoices(),
      api.getVoiceConfig(),
      api.getCharacters().catch(() => ({ characters: [] })),
    ]).then(([v, c, ch]) => {
      setVoices(v.voices)
      setTtsEnabled(v.ttsEnabled)
      setConfig(c)
      setCharacters(ch.characters)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const save = async (newConfig: VoiceConfig) => {
    setSaving(true)
    try {
      const saved = await api.saveVoiceConfig(newConfig)
      setConfig(saved)
    } finally {
      setSaving(false)
    }
  }

  const stopAudio = () => {
    audioRef.current?.pause()
    audioRef.current = null
    setPreviewingId(null)
  }

  const preview = async (voiceId: string) => {
    if (previewingId) {
      stopAudio()
      if (previewingId === voiceId) return
    }
    setPreviewingId(voiceId)
    try {
      const url = await api.previewVoice(voiceId, previewText || undefined)
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => setPreviewingId(null)
      audio.onerror = () => setPreviewingId(null)
      audio.play()
    } catch {
      setPreviewingId(null)
    }
  }

  const setDefaultVoice = (voiceId: string) => {
    const next = { ...config, defaultVoice: voiceId }
    setConfig(next)
    save(next)
  }

  // --- NPC ---
  const setNpcVoiceFor = (name: string, voiceId: string) => {
    const next = { ...config, npcVoices: { ...config.npcVoices, [name]: voiceId } }
    setConfig(next)
    save(next)
  }

  const addNpcVoice = () => {
    const name = npcName.trim()
    if (!name || !npcVoice) return
    setNpcVoiceFor(name, npcVoice)
    setNpcName('')
    setNpcVoice('')
  }

  const removeNpcVoice = (name: string) => {
    const npcVoices = { ...config.npcVoices }
    delete npcVoices[name]
    const next = { ...config, npcVoices }
    setConfig(next)
    save(next)
  }

  // --- Blend ---
  const updateBlendSlot = (idx: number, field: 'id' | 'weight', value: string | number) => {
    setBlendSlots((prev) => prev.map((v, i) => i === idx ? { ...v, [field]: value } : v))
  }

  const addBlendSlot = () => setBlendSlots((prev) => [...prev, { id: '', weight: 1 }])

  const removeBlendSlot = (idx: number) => {
    if (blendSlots.length <= 2) return
    setBlendSlots((prev) => prev.filter((_, i) => i !== idx))
  }

  const validBlendSlots = blendSlots.filter((v) => v.id && v.weight > 0)
  const blendExpr = validBlendSlots.length >= 2 ? buildBlendExpression(validBlendSlots) : null

  const previewBlend = () => {
    if (blendExpr) preview(blendExpr)
  }

  const saveBlend = () => {
    if (!blendExpr || !blendName.trim()) return
    const blends = [...(config.savedBlends || []), { name: blendName.trim(), expression: blendExpr }]
    const next = { ...config, savedBlends: blends }
    setConfig(next)
    save(next)
    setBlendName('')
  }

  const removeBlend = (idx: number) => {
    const blends = [...(config.savedBlends || [])]
    blends.splice(idx, 1)
    const next = { ...config, savedBlends: blends }
    setConfig(next)
    save(next)
  }

  if (loading) return <div className="page"><div className="loading">Loading...</div></div>

  const gradeOrder = ['A', 'A-', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F+', '-']
  const sorted = [...voices].sort((a, b) => {
    const ai = gradeOrder.indexOf(a.grade)
    const bi = gradeOrder.indexOf(b.grade)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })
  const baseVoices = sorted.filter((v) => v.accent !== 'Custom')

  const filteredVoices = sorted.filter((v) => {
    if (catalogGender && v.gender !== catalogGender) return false
    if (catalogAccent && v.accent !== catalogAccent) return false
    if (catalogSearch) {
      const q = catalogSearch.toLowerCase()
      if (!v.name.toLowerCase().includes(q) && !v.id.toLowerCase().includes(q)) return false
    }
    return true
  })

  const allVoiceOptions = () => {
    const opts: Array<{ id: string; label: string }> = sorted.map((v) => ({
      id: v.id,
      label: `${v.name} (${v.gender === 'female' ? '\u2640' : '\u2642'} ${v.accent}${v.grade !== '-' ? `, ${v.grade}` : ''})`,
    }))
    // Add saved blends
    for (const b of config.savedBlends || []) {
      opts.push({ id: b.expression, label: `${b.name} (Blend)` })
    }
    return opts
  }

  // Characters not already assigned a voice
  const unassignedCharacters = characters.filter((ch) => !config.npcVoices[ch])

  return (
    <div className="page voice-settings">
      <h1>Voices</h1>

      {!ttsEnabled && (
        <div className="voice-warning">
          TTS is disabled. Set <code>TTS_ENABLED=true</code> and start Kokoro to use voices.
        </div>
      )}

      <section className="voice-section">
        <h2>Preview Text</h2>
        <textarea
          className="input voice-preview-input"
          rows={2}
          placeholder="Custom preview text (optional)"
          value={previewText}
          onChange={(e) => setPreviewText(e.target.value)}
        />
      </section>

      {/* --- Blend Voices --- */}
      <section className="voice-section">
        <h2>Blend Voices</h2>
        <p className="voice-hint">
          Combine voices with weights. The blend is passed directly to Kokoro — no saving required.
        </p>

        <div className="blend-slots">
          {blendSlots.map((bv, idx) => (
            <div key={idx} className="blend-slot">
              <select
                className="input blend-voice-select"
                value={bv.id}
                onChange={(e) => updateBlendSlot(idx, 'id', e.target.value)}
              >
                <option value="">Select voice...</option>
                {baseVoices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.gender === 'female' ? '\u2640' : '\u2642'} {v.accent}, {v.grade})
                  </option>
                ))}
              </select>
              <div className="blend-weight">
                <label className="blend-weight-label">Weight</label>
                <input
                  type="range"
                  className="blend-weight-slider"
                  min={1}
                  max={5}
                  step={1}
                  value={bv.weight}
                  onChange={(e) => updateBlendSlot(idx, 'weight', Number(e.target.value))}
                />
                <span className="blend-weight-value">{bv.weight}</span>
              </div>
              {blendSlots.length > 2 && (
                <button className="btn btn-sm" onClick={() => removeBlendSlot(idx)}>{'\u2715'}</button>
              )}
            </div>
          ))}
        </div>

        <div className="blend-actions">
          <button className="btn btn-sm" onClick={addBlendSlot}>+ Add Voice</button>
          <button
            className="btn btn-sm"
            onClick={previewBlend}
            disabled={!ttsEnabled || !blendExpr || previewingId !== null}
          >
            {'\u25B6'} Preview Blend
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => blendExpr && setDefaultVoice(blendExpr)}
            disabled={!blendExpr || saving}
          >
            Use as GM Voice
          </button>
        </div>

        {blendExpr && (
          <div className="blend-save">
            <input
              className="input"
              placeholder="Blend name (e.g. Warm Narrator)"
              value={blendName}
              onChange={(e) => setBlendName(e.target.value)}
            />
            <button
              className="btn btn-sm btn-primary"
              onClick={saveBlend}
              disabled={!blendName.trim()}
            >
              Save Blend
            </button>
          </div>
        )}

        {(config.savedBlends || []).length > 0 && (
          <div className="saved-blends">
            <h3>Saved Blends</h3>
            {(config.savedBlends || []).map((b, idx) => (
              <div key={idx} className="blend-row">
                <span className="blend-row-name">{b.name}</span>
                <span className="blend-row-expr">{b.expression}</span>
                <button
                  className="btn btn-sm"
                  onClick={() => preview(b.expression)}
                  disabled={!ttsEnabled || (previewingId !== null && previewingId !== b.expression)}
                >
                  {previewingId === b.expression ? '\u25A0' : '\u25B6'}
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => setDefaultVoice(b.expression)}
                  disabled={saving}
                >
                  Use
                </button>
                <button className="btn btn-sm" onClick={() => removeBlend(idx)}>{'\u2715'}</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* --- NPC Voices --- */}
      <section className="voice-section">
        <h2>NPC Voices</h2>
        <p className="voice-hint">
          Map character names to specific voices.
          {characters.length > 0 && ' Characters from your sessions appear in the dropdown.'}
        </p>

        {/* Assigned characters */}
        {Object.entries(config.npcVoices).length > 0 && (
          <div className="npc-list">
            {Object.entries(config.npcVoices).map(([name, vid]) => (
              <div key={name} className="npc-row">
                <span className="npc-name">{name}</span>
                <select
                  className="input npc-voice-select"
                  value={vid}
                  onChange={(e) => setNpcVoiceFor(name, e.target.value)}
                >
                  {allVoiceOptions().map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
                <button
                  className="btn btn-sm"
                  onClick={() => preview(vid)}
                  disabled={!ttsEnabled || (previewingId !== null && previewingId !== vid)}
                >
                  {previewingId === vid ? '\u25A0' : '\u25B6'}
                </button>
                <button className="btn btn-sm" onClick={() => removeNpcVoice(name)}>Remove</button>
              </div>
            ))}
          </div>
        )}

        {/* Unassigned characters — one-click assign */}
        {unassignedCharacters.length > 0 && (
          <div className="npc-unassigned">
            <h3>Unassigned Characters</h3>
            {unassignedCharacters.map((ch) => (
              <div key={ch} className="npc-row">
                <span className="npc-name">{ch}</span>
                <select
                  className="input npc-voice-select"
                  value=""
                  onChange={(e) => { if (e.target.value) setNpcVoiceFor(ch, e.target.value) }}
                >
                  <option value="">Pick a voice...</option>
                  {allVoiceOptions().map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
                <button
                  className="btn btn-sm"
                  disabled
                >
                  {'\u25B6'}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Manual add */}
        <div className="npc-add">
          <input
            className="input"
            placeholder="Or type a character name..."
            value={npcName}
            onChange={(e) => setNpcName(e.target.value)}
          />
          <select
            className="input"
            value={npcVoice}
            onChange={(e) => setNpcVoice(e.target.value)}
          >
            <option value="">Select voice...</option>
            {allVoiceOptions().map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            onClick={addNpcVoice}
            disabled={!npcName.trim() || !npcVoice}
          >
            Add
          </button>
        </div>
      </section>

      {/* --- GM Voice --- */}
      <section className="voice-section">
        <h2>GM Voice</h2>
        <div className="gm-voice-picker">
          <select
            className="input gm-voice-select"
            value={config.defaultVoice}
            onChange={(e) => setDefaultVoice(e.target.value)}
          >
            {allVoiceOptions().map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <button
            className="btn btn-sm"
            onClick={() => preview(config.defaultVoice)}
            disabled={!ttsEnabled || previewingId !== null}
          >
            {previewingId === config.defaultVoice ? '\u25A0 Stop' : '\u25B6 Preview'}
          </button>
        </div>
      </section>

      {/* --- Voice Catalog --- */}
      <section className="voice-section">
        <h2>Voice Catalog</h2>
        <div className="catalog-controls">
          <input
            className="input catalog-search"
            placeholder="Search voices..."
            value={catalogSearch}
            onChange={(e) => setCatalogSearch(e.target.value)}
          />
          <select
            className="input catalog-filter"
            value={catalogGender}
            onChange={(e) => setCatalogGender(e.target.value)}
          >
            <option value="">All genders</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
          <select
            className="input catalog-filter"
            value={catalogAccent}
            onChange={(e) => setCatalogAccent(e.target.value)}
          >
            <option value="">All accents</option>
            {[...new Set(voices.map((v) => v.accent))].sort().map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>

        <div className="voice-grid">
          {filteredVoices.map((v) => (
            <div
              key={v.id}
              className={`voice-card ${config.defaultVoice === v.id ? 'voice-card-selected' : ''}`}
            >
              <div className="voice-card-info">
                <span className="voice-card-name">{v.name}</span>
                <span className="voice-card-meta">
                  {v.gender === 'female' ? '\u2640' : '\u2642'} {v.accent}
                </span>
                {v.grade !== '-' && (
                  <span className={`voice-card-grade grade-${v.grade.replace(/[+-]/g, '').toLowerCase()}`}>
                    {v.grade}
                  </span>
                )}
              </div>
              <div className="voice-card-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => preview(v.id)}
                  disabled={!ttsEnabled || (previewingId !== null && previewingId !== v.id)}
                >
                  {previewingId === v.id ? '\u25A0 Stop' : '\u25B6 Play'}
                </button>
                {config.defaultVoice !== v.id && (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => setDefaultVoice(v.id)}
                    disabled={saving}
                  >
                    GM
                  </button>
                )}
                {config.defaultVoice === v.id && (
                  <span className="voice-active-badge">GM Voice</span>
                )}
              </div>
            </div>
          ))}
          {filteredVoices.length === 0 && (
            <div className="voice-empty">No voices match your filters</div>
          )}
        </div>
      </section>
    </div>
  )
}
