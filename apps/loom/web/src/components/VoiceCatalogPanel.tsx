import { useState } from "react";
import type { Voice, VoiceConfig } from "../lib/types";
import { sortVoices } from "./voice-helpers";

interface Props {
  voices: Voice[];
  config: VoiceConfig;
  ttsEnabled: boolean;
  saving: boolean;
  previewingId: string | null;
  preview: (voiceId: string, text?: string) => Promise<void>;
  setDefaultVoice: (id: string) => void;
}

export function VoiceCatalogPanel({
  voices,
  config,
  ttsEnabled,
  saving,
  previewingId,
  preview,
  setDefaultVoice,
}: Props) {
  const [search, setSearch] = useState("");
  const [gender, setGender] = useState("");
  const [accent, setAccent] = useState("");

  const sorted = sortVoices(voices);

  const filtered = sorted.filter((v) => {
    if (gender && v.gender !== gender) return false;
    if (accent && v.accent !== accent) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!v.name.toLowerCase().includes(q) && !v.id.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const accents = [...new Set(voices.map((v) => v.accent))].toSorted();

  return (
    <section className="voice-section">
      <h2>Voice Catalog</h2>
      <div className="catalog-controls">
        <input
          className="input catalog-search"
          placeholder="Search voices..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="input catalog-filter"
          value={gender}
          onChange={(e) => setGender(e.target.value)}
        >
          <option value="">All genders</option>
          <option value="female">Female</option>
          <option value="male">Male</option>
        </select>
        <select
          className="input catalog-filter"
          value={accent}
          onChange={(e) => setAccent(e.target.value)}
        >
          <option value="">All accents</option>
          {accents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      <div className="voice-grid">
        {filtered.map((v) => (
          <div
            key={v.id}
            className={`voice-card ${config.defaultVoice === v.id ? "voice-card-selected" : ""}`}
          >
            <div className="voice-card-info">
              <span className="voice-card-name">{v.name}</span>
              <span className="voice-card-meta">
                {v.gender === "female" ? "\u2640" : "\u2642"} {v.accent}
              </span>
              {v.grade !== "-" && (
                <span
                  className={`voice-card-grade grade-${v.grade.replace(/[+-]/g, "").toLowerCase()}`}
                >
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
                {previewingId === v.id ? "\u25A0 Stop" : "\u25B6 Play"}
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
              {config.defaultVoice === v.id && <span className="voice-active-badge">GM Voice</span>}
            </div>
          </div>
        ))}
        {filtered.length === 0 && <div className="voice-empty">No voices match your filters</div>}
      </div>
    </section>
  );
}
