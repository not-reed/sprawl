import { useState, useCallback } from "react";
import { api } from "../lib/api";
import type { Session, Observation } from "../lib/types";

export function useSession(sessionId: string) {
  const [session, setSession] = useState<Session | null>(null);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.getSession(sessionId);
      setSession(s);
      const { observations: obs } = await api.getObservations(sessionId);
      setObservations(obs);
    } catch (err) {
      console.error("Failed to load session:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const toggleMode = useCallback(async () => {
    if (!session) return;
    const newMode = session.mode === "play" ? "recap" : "play";
    const updated = await api.updateSession(sessionId, { mode: newMode });
    setSession(updated);
  }, [session, sessionId]);

  const refreshObservations = useCallback(async () => {
    try {
      const { observations: obs } = await api.getObservations(sessionId);
      setObservations(obs);
    } catch (err) {
      console.error("Failed to refresh observations:", err);
    }
  }, [sessionId]);

  return { session, observations, loading, load, toggleMode, refreshObservations };
}
