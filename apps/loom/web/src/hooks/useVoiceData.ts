import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Voice, VoiceConfig } from "../lib/types";

export interface VoiceData {
  voices: Voice[];
  config: VoiceConfig;
  characters: string[];
  ttsEnabled: boolean;
  loading: boolean;
  save: (next: VoiceConfig) => Promise<void>;
  saving: boolean;
}

export function useVoiceData(): VoiceData {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [config, setConfig] = useState<VoiceConfig>({
    defaultVoice: "af_heart",
    npcVoices: {},
    savedBlends: [],
  });
  const [characters, setCharacters] = useState<string[]>([]);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getVoices(),
      api.getVoiceConfig(),
      api.getCharacters().catch(() => ({ characters: [] })),
    ])
      .then(([v, c, ch]) => {
        setVoices(v.voices);
        setTtsEnabled(v.ttsEnabled);
        setConfig(c);
        setCharacters(ch.characters);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = async (next: VoiceConfig) => {
    setSaving(true);
    try {
      const saved = await api.saveVoiceConfig(next);
      setConfig(saved);
    } finally {
      setSaving(false);
    }
  };

  return { voices, config, characters, ttsEnabled, loading, save, saving };
}
