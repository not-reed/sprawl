import { useState } from "react";
import type { Voice, VoiceConfig } from "../lib/types";
import { buildBlendExpression, sortVoices } from "./voice-helpers";

interface PanelProps {
  voices: Voice[];
  config: VoiceConfig;
  ttsEnabled: boolean;
  saving: boolean;
  previewingId: string | null;
  previewText: string;
  preview: (voiceId: string, text?: string) => Promise<void>;
  onSave: (next: VoiceConfig) => Promise<void>;
  setDefaultVoice: (id: string) => void;
}

function BlendSlotList({
  blendSlots,
  baseVoices,
  onUpdate,
  onRemove,
}: {
  blendSlots: Array<{ id: string; weight: number }>;
  baseVoices: Voice[];
  onUpdate: (idx: number, field: "id" | "weight", value: string | number) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="blend-slots">
      {blendSlots.map((bv, idx) => (
        <div key={idx} className="blend-slot">
          <select
            className="input blend-voice-select"
            value={bv.id}
            onChange={(e) => onUpdate(idx, "id", e.target.value)}
          >
            <option value="">Select voice...</option>
            {baseVoices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.gender === "female" ? "\u2640" : "\u2642"} {v.accent}, {v.grade})
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
              onChange={(e) => onUpdate(idx, "weight", Number(e.target.value))}
            />
            <span className="blend-weight-value">{bv.weight}</span>
          </div>
          {blendSlots.length > 2 && (
            <button className="btn btn-sm" onClick={() => onRemove(idx)}>
              {"\u2715"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function BlendSaveForm({
  blendName,
  onChange,
  onSave,
}: {
  blendName: string;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="blend-save">
      <input
        className="input"
        placeholder="Blend name (e.g. Warm Narrator)"
        value={blendName}
        onChange={(e) => onChange(e.target.value)}
      />
      <button className="btn btn-sm btn-primary" onClick={onSave} disabled={!blendName.trim()}>
        Save Blend
      </button>
    </div>
  );
}

function SavedBlendList({
  savedBlends,
  ttsEnabled,
  saving,
  previewingId,
  preview,
  onSetDefault,
  onRemove,
}: {
  savedBlends: VoiceConfig["savedBlends"];
  ttsEnabled: boolean;
  saving: boolean;
  previewingId: string | null;
  preview: (voiceId: string, text?: string) => Promise<void>;
  onSetDefault: (id: string) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="saved-blends">
      <h3>Saved Blends</h3>
      {(savedBlends || []).map((b, idx) => (
        <div key={idx} className="blend-row">
          <span className="blend-row-name">{b.name}</span>
          <span className="blend-row-expr">{b.expression}</span>
          <button
            className="btn btn-sm"
            onClick={() => preview(b.expression)}
            disabled={!ttsEnabled || (previewingId !== null && previewingId !== b.expression)}
          >
            {previewingId === b.expression ? "\u25A0" : "\u25B6"}
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => onSetDefault(b.expression)}
            disabled={saving}
          >
            Use
          </button>
          <button className="btn btn-sm" onClick={() => onRemove(idx)}>
            {"\u2715"}
          </button>
        </div>
      ))}
    </div>
  );
}

export function VoiceBlendPanel({
  voices,
  config,
  ttsEnabled,
  saving,
  previewingId,
  previewText,
  preview,
  onSave,
  setDefaultVoice,
}: PanelProps) {
  const [blendSlots, setBlendSlots] = useState<Array<{ id: string; weight: number }>>([
    { id: "", weight: 1 },
    { id: "", weight: 1 },
  ]);
  const [blendName, setBlendName] = useState("");

  const sorted = sortVoices(voices);
  const baseVoices = sorted.filter((v) => v.accent !== "Custom");

  const updateSlot = (idx: number, field: "id" | "weight", value: string | number) => {
    setBlendSlots((prev) => prev.map((v, i) => (i === idx ? { ...v, [field]: value } : v)));
  };

  const addSlot = () => setBlendSlots((prev) => [...prev, { id: "", weight: 1 }]);

  const removeSlot = (idx: number) => {
    if (blendSlots.length <= 2) return;
    setBlendSlots((prev) => prev.filter((_, i) => i !== idx));
  };

  const valid = blendSlots.filter((v) => v.id && v.weight > 0);
  const expr = valid.length >= 2 ? buildBlendExpression(valid) : null;

  const previewBlend = () => {
    if (expr) preview(expr, previewText);
  };

  const saveBlend = () => {
    if (!expr || !blendName.trim()) return;
    const blends = [...(config.savedBlends || []), { name: blendName.trim(), expression: expr }];
    onSave({ ...config, savedBlends: blends });
    setBlendName("");
  };

  const removeBlend = (idx: number) => {
    const blends = [...(config.savedBlends || [])];
    blends.splice(idx, 1);
    onSave({ ...config, savedBlends: blends });
  };

  return (
    <section className="voice-section">
      <h2>Blend Voices</h2>
      <p className="voice-hint">
        Combine voices with weights. The blend is passed directly to Kokoro — no saving required.
      </p>

      <BlendSlotList
        blendSlots={blendSlots}
        baseVoices={baseVoices}
        onUpdate={updateSlot}
        onRemove={removeSlot}
      />

      <div className="blend-actions">
        <button className="btn btn-sm" onClick={addSlot}>
          + Add Voice
        </button>
        <button
          className="btn btn-sm"
          onClick={previewBlend}
          disabled={!ttsEnabled || !expr || previewingId !== null}
        >
          {"\u25B6"} Preview Blend
        </button>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => expr && setDefaultVoice(expr)}
          disabled={!expr || saving}
        >
          Use as GM Voice
        </button>
      </div>

      {expr && <BlendSaveForm blendName={blendName} onChange={setBlendName} onSave={saveBlend} />}

      {(config.savedBlends || []).length > 0 && (
        <SavedBlendList
          savedBlends={config.savedBlends}
          ttsEnabled={ttsEnabled}
          saving={saving}
          previewingId={previewingId}
          preview={preview}
          onSetDefault={setDefaultVoice}
          onRemove={removeBlend}
        />
      )}
    </section>
  );
}
