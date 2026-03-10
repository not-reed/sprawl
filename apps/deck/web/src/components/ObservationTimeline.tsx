import { useState, useCallback } from "react";
import { useApi } from "../hooks/useApi";
import { api } from "../lib/api";
import type { Observation } from "../lib/types";

export function ObservationTimeline() {
  const { data: convData } = useApi(() => api.getConversations(), []);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [loading, setLoading] = useState(false);

  const loadObservations = useCallback(async (convId: string, includeSup: boolean) => {
    setLoading(true);
    try {
      const res = includeSup
        ? await api.getAllObservations(convId)
        : await api.getObservations(convId);
      setObservations(res.observations);
    } catch {
      setObservations([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleConvChange = (convId: string) => {
    setSelectedConvId(convId);
    if (convId) loadObservations(convId, showSuperseded);
  };

  const handleToggleSuperseded = () => {
    const next = !showSuperseded;
    setShowSuperseded(next);
    if (selectedConvId) loadObservations(selectedConvId, next);
  };

  const conversations = convData?.conversations ?? [];

  return (
    <div className="page">
      <div className="conversation-picker">
        <select value={selectedConvId ?? ""} onChange={(e) => handleConvChange(e.target.value)}>
          <option value="">Select a conversation...</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.source}
              {c.external_id ? ` (${c.external_id})` : ""} &mdash; {c.observation_count}{" "}
              observations &mdash; {new Date(c.updated_at).toLocaleDateString()}
            </option>
          ))}
        </select>
      </div>

      {selectedConvId && (
        <label className="toggle-superseded" onClick={handleToggleSuperseded}>
          <input type="checkbox" checked={showSuperseded} onChange={handleToggleSuperseded} />
          Show superseded observations
        </label>
      )}

      {loading && <div className="loading">Loading observations...</div>}

      {!loading && selectedConvId && observations.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No observations</div>
          <div>This conversation has no observations yet</div>
        </div>
      )}

      {!loading && observations.length > 0 && (
        <div className="timeline">
          {observations.map((obs) => (
            <div
              key={obs.id}
              className={`timeline-item priority-${obs.priority} ${
                obs.superseded_at ? "superseded" : ""
              }`}
            >
              <div className="timeline-header">
                <span className={`badge-priority badge-priority-${obs.priority}`}>
                  {obs.priority}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Gen {obs.generation}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: "auto" }}>
                  {new Date(obs.observation_date).toLocaleString()}
                </span>
              </div>
              <div className="timeline-content">{obs.content}</div>
              <div className="timeline-meta">
                {obs.superseded_at && (
                  <span>Superseded {new Date(obs.superseded_at).toLocaleString()}</span>
                )}
                {obs.token_count && <span> | {obs.token_count} tokens</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {!selectedConvId && (
        <div className="empty-state">
          <div className="empty-state-title">Select a conversation</div>
          <div>Choose a conversation above to view its observation timeline</div>
        </div>
      )}
    </div>
  );
}
