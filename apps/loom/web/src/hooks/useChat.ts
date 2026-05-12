import { useState, useCallback, useRef } from "react";
import { api } from "../lib/api";
import type { Message } from "../lib/types";

function useChatStream(
  sessionId: string,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  ttsEnabledRef: React.MutableRefObject<boolean>,
  setPendingAudioUrl: (url: string | null) => void,
) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      if (isStreaming || !text.trim()) return;

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

        const assistantMsg: Message = {
          id: `temp-${Date.now()}-assistant`,
          conversation_id: "",
          role: "assistant",
          content: fullText,
          tool_calls: null,
          created_at: new Date().toISOString(),
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

  return { isStreaming, streamingText, sendMessage };
}

export function useChat(sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pendingAudioUrl, setPendingAudioUrl] = useState<string | null>(null);
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

  const { isStreaming, streamingText, sendMessage } = useChatStream(
    sessionId,
    setMessages,
    ttsEnabledRef,
    setPendingAudioUrl,
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
