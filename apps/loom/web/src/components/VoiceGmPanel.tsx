import type { Voice, VoiceConfig } from "../lib/types";
import { buildVoiceOptions } from "./voice-helpers";

interface Props {
  config: VoiceConfig;
  voices: Voice[];
  ttsEnabled: boolean;
  previewingId: string | null;
  preview: (voiceId: string, text?: string) => Promise<void>;
  setDefaultVoice: (id: string) => void;
}

export function VoiceGmPanel({
  config,
  voices,
  ttsEnabled,
  previewingId,
  preview,
  setDefaultVoice,
}: Props) {
  const options = buildVoiceOptions(voices, config.savedBlends);

  return (
    <section className="voice-section">
      <h2>GM Voice</h2>
      <div className="gm-voice-picker">
        <select
          className="input gm-voice-select"
          value={config.defaultVoice}
          onChange={(e) => setDefaultVoice(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          className="btn btn-sm"
          onClick={() => preview(config.defaultVoice)}
          disabled={!ttsEnabled || previewingId !== null}
        >
          {previewingId === config.defaultVoice ? "\u25A0 Stop" : "\u25B6 Preview"}
        </button>
      </div>
    </section>
  );
}
