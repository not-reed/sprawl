import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { api } from "../lib/api";

export function CampaignView() {
  const { id } = useParams<{ id: string }>();
  const { data, loading } = useApi(() => api.getCampaign(id!), [id]);
  const [creating, setCreating] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const navigate = useNavigate();

  const handleNewSession = async (mode: "play" | "recap" = "play") => {
    if (!id) return;
    setCreating(true);
    try {
      const session = await api.createSession(id, {
        name: sessionName.trim() || undefined,
        mode,
      });
      setSessionName("");
      navigate(`/play/${session.id}`);
    } catch (err) {
      console.error("Failed to create session:", err);
    } finally {
      setCreating(false);
    }
  };

  if (loading || !data)
    return (
      <div className="page">
        <div className="loading">Loading...</div>
      </div>
    );

  const sessions = data.sessions ?? [];

  return (
    <div className="page">
      <div className="campaign-header">
        <h1>{data.name}</h1>
        {data.system && <div className="campaign-system">{data.system}</div>}
        {data.description && <p className="campaign-description">{data.description}</p>}
      </div>

      <div className="create-form">
        <input
          className="input"
          type="text"
          placeholder="Session name (optional)"
          value={sessionName}
          onChange={(e) => setSessionName(e.target.value)}
        />
        <div className="btn-row">
          <button
            className="btn btn-primary"
            onClick={() => handleNewSession("play")}
            disabled={creating}
          >
            New Play Session
          </button>
          <button className="btn" onClick={() => handleNewSession("recap")} disabled={creating}>
            New Recap Session
          </button>
        </div>
      </div>

      {sessions.length > 0 && (
        <div className="session-list">
          <h2>Sessions</h2>
          {sessions.map((s) => (
            <div key={s.id} className="session-card" onClick={() => navigate(`/play/${s.id}`)}>
              <div className="session-name">
                {s.name || `Session ${new Date(s.created_at).toLocaleDateString()}`}
              </div>
              <div className="session-meta">
                <span className={`badge badge-${s.mode}`}>{s.mode}</span>
                <span className={`badge badge-${s.status}`}>{s.status}</span>
                <span>{new Date(s.updated_at).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {sessions.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No sessions yet</div>
          <div>Start a play or recap session</div>
        </div>
      )}
    </div>
  );
}
