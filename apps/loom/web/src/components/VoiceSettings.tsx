import { useCallback, useState } from "react";
import { useVoiceData } from "../hooks/useVoiceData";
import { usePreviewAudio } from "../hooks/usePreviewAudio";
import { VoiceBlendPanel } from "./VoiceBlendPanel";
import { VoiceNpcPanel } from "./VoiceNpcPanel";
import { VoiceGmPanel } from "./VoiceGmPanel";
import { VoiceCatalogPanel } from "./VoiceCatalogPanel";

export function VoiceSettings() {
  const { voices, config, characters, ttsEnabled, loading, save, saving } = useVoiceData();
  const { previewingId, preview, stopAudio } = usePreviewAudio();
  const [previewText, setPreviewText] = useState("");

  const setDefaultVoice = useCallback(
    (voiceId: string) => {
      save({ ...config, defaultVoice: voiceId });
    },
    [config, save],
  );

  if (loading)
    return (
      <div className="page">
        <div className="loading">Loading...</div>
      </div>
    );

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
          onChange={(e) => {
            setPreviewText(e.target.value);
            stopAudio();
          }}
        />
      </section>

      <VoiceBlendPanel
        voices={voices}
        config={config}
        ttsEnabled={ttsEnabled}
        saving={saving}
        previewingId={previewingId}
        previewText={previewText}
        preview={preview}
        onSave={save}
        setDefaultVoice={setDefaultVoice}
      />

      <VoiceNpcPanel
        config={config}
        characters={characters}
        voices={voices}
        ttsEnabled={ttsEnabled}
        saving={saving}
        previewingId={previewingId}
        preview={preview}
        onSave={save}
      />

      <VoiceGmPanel
        config={config}
        voices={voices}
        ttsEnabled={ttsEnabled}
        previewingId={previewingId}
        preview={preview}
        setDefaultVoice={setDefaultVoice}
      />

      <VoiceCatalogPanel
        voices={voices}
        config={config}
        ttsEnabled={ttsEnabled}
        saving={saving}
        previewingId={previewingId}
        preview={preview}
        setDefaultVoice={setDefaultVoice}
      />
    </div>
  );
}
