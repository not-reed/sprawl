import { useCallback, useRef, useState } from "react";
import { api } from "../lib/api";

export function usePreviewAudio() {
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPreviewingId(null);
  }, []);

  const preview = useCallback(
    async (voiceId: string, previewText?: string) => {
      if (previewingId) {
        stopAudio();
        if (previewingId === voiceId) return;
      }
      setPreviewingId(voiceId);
      try {
        const url = await api.previewVoice(voiceId, previewText || undefined);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.addEventListener("ended", () => setPreviewingId(null));
        audio.addEventListener("error", () => setPreviewingId(null));
        audio.play();
      } catch {
        setPreviewingId(null);
      }
    },
    [previewingId, stopAudio],
  );

  return { previewingId, preview, stopAudio };
}
