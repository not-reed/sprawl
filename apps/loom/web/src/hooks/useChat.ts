import { useState, useCallback, useRef } from "react";
import { api } from "../lib/api";
import type { Message } from "../lib/types";

export function useChat(sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [pendingAudioUrl, setPendingAudioUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const ttsEnabledRef = useRef(false);

  const setTtsEnabled = useCallback((enabled: boolean) => {
    ttsEnabledRef.current = enabled;
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const { messages: history } = await api.getChatHistory(sessionId);
      setMessages(history);
      setLoaded(true);
    } catch (err) {
      console.error("Failed to load history:", err);
      setLoaded(true);
    }
  }, [sessionId]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (isStreaming || !text.trim()) return;

      // Optimistic user message
      const userMsg: Message = {
        id: `temp-${Date.now()}`,
        conversation_id: "",
        role: "user",
        content: text,
        tool_calls: null,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsStreaming(true);
      setStreamingText("");
      setPendingAudioUrl(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: text }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Chat error: ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let fullText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          accumulated += decoder.decode(value, { stream: true });
          const lines = accumulated.split("\n");
          accumulated = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;

            try {
              const event = JSON.parse(raw);
              if (event.type === "delta") {
                fullText += event.text;
                setStreamingText(fullText);
              } else if (event.type === "done") {
                fullText = event.text;
              } else if (event.type === "audio") {
                // Auto-play if TTS enabled, otherwise store URL for manual play
                if (ttsEnabledRef.current) {
                  try {
                    const audio = new Audio(event.url);
                    audio.play();
                  } catch {
                    // Audio playback failed — not critical
                  }
                }
                setPendingAudioUrl(event.url);
              } else if (event.type === "error") {
                console.error("Stream error:", event.error);
              }
            } catch {
              // Skip malformed SSE lines
            }
          }
        }

        // Add assistant message with audio URL if present
        const assistantMsg: Message = {
          id: `temp-${Date.now()}-assistant`,
          conversation_id: "",
          role: "assistant",
          content: fullText,
          tool_calls: null,
          created_at: new Date().toISOString(),
          audioUrl: undefined, // set below after state settles
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("Stream failed:", err);
        }
      } finally {
        setIsStreaming(false);
        setStreamingText("");
        abortRef.current = null;
      }
    },
    [sessionId, isStreaming],
  );

  return {
    messages,
    isStreaming,
    streamingText,
    loaded,
    pendingAudioUrl,
    loadHistory,
    sendMessage,
    setTtsEnabled,
  };
}
