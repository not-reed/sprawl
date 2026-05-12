import { useState } from "react";
import type { Voice, VoiceConfig } from "../lib/types";
import { buildVoiceOptions } from "./voice-helpers";

interface PanelProps {
  config: VoiceConfig;
  characters: string[];
  voices: Voice[];
  ttsEnabled: boolean;
  previewingId: string | null;
  preview: (voiceId: string, text?: string) => Promise<void>;
  onSave: (next: VoiceConfig) => Promise<void>;
}

function AssignedNpcList({
  config,
  options,
  ttsEnabled,
  previewingId,
  preview,
  onSave,
}: {
  config: VoiceConfig;
  options: Array<{ id: string; label: string }>;
  ttsEnabled: boolean;
  previewingId: string | null;
  preview: (voiceId: string, text?: string) => Promise<void>;
  onSave: (next: VoiceConfig) => Promise<void>;
}) {
  const setNpcVoiceFor = (name: string, voiceId: string) => {
    onSave({ ...config, npcVoices: { ...config.npcVoices, [name]: voiceId } });
  };
  const removeNpcVoice = (name: string) => {
    const npcVoices = { ...config.npcVoices };
    delete npcVoices[name];
    onSave({ ...config, npcVoices });
  };

  return (
    <div className="npc-list">
      {Object.entries(config.npcVoices).map(([name, vid]) => (
        <div key={name} className="npc-row">
          <span className="npc-name">{name}</span>
          <select
            className="input npc-voice-select"
            value={vid}
            onChange={(e) => setNpcVoiceFor(name, e.target.value)}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            className="btn btn-sm"
            onClick={() => preview(vid)}
            disabled={!ttsEnabled || (previewingId !== null && previewingId !== vid)}
          >
            {previewingId === vid ? "\u25A0" : "\u25B6"}
          </button>
          <button className="btn btn-sm" onClick={() => removeNpcVoice(name)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

function UnassignedNpcList({
  unassigned,
  options,
  onSetVoice,
}: {
  unassigned: string[];
  options: Array<{ id: string; label: string }>;
  onSetVoice: (name: string, voiceId: string) => void;
}) {
  return (
    <div className="npc-unassigned">
      <h3>Unassigned Characters</h3>
      {unassigned.map((ch) => (
        <div key={ch} className="npc-row">
          <span className="npc-name">{ch}</span>
          <select
            className="input npc-voice-select"
            value=""
            onChange={(e) => {
              if (e.target.value) onSetVoice(ch, e.target.value);
            }}
          >
            <option value="">Pick a voice...</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <button className="btn btn-sm" disabled>
            {"\u25B6"}
          </button>
        </div>
      ))}
    </div>
  );
}

export function VoiceNpcPanel({
  config,
  characters,
  voices,
  ttsEnabled,
  previewingId,
  preview,
  onSave,
}: PanelProps) {
  const [npcName, setNpcName] = useState("");
  const [npcVoice, setNpcVoice] = useState("");

  const setNpcVoiceFor = (name: string, voiceId: string) => {
    onSave({ ...config, npcVoices: { ...config.npcVoices, [name]: voiceId } });
  };

  const addNpcVoice = () => {
    const name = npcName.trim();
    if (!name || !npcVoice) return;
    setNpcVoiceFor(name, npcVoice);
    setNpcName("");
    setNpcVoice("");
  };

  const options = buildVoiceOptions(voices, config.savedBlends);
  const unassigned = characters.filter((ch) => !config.npcVoices[ch]);

  return (
    <section className="voice-section">
      <h2>NPC Voices</h2>
      <p className="voice-hint">
        Map character names to specific voices.
        {characters.length > 0 && " Characters from your sessions appear in the dropdown."}
      </p>

      {Object.entries(config.npcVoices).length > 0 && (
        <AssignedNpcList
          config={config}
          options={options}
          ttsEnabled={ttsEnabled}
          previewingId={previewingId}
          preview={preview}
          onSave={onSave}
        />
      )}

      {unassigned.length > 0 && (
        <UnassignedNpcList unassigned={unassigned} options={options} onSetVoice={setNpcVoiceFor} />
      )}

      <div className="npc-add">
        <input
          className="input"
          placeholder="Or type a character name..."
          value={npcName}
          onChange={(e) => setNpcName(e.target.value)}
        />
        <select className="input" value={npcVoice} onChange={(e) => setNpcVoice(e.target.value)}>
          <option value="">Select voice...</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
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
  );
}
