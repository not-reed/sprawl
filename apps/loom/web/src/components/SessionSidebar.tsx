import type { Observation } from "../lib/types";

interface SessionSidebarProps {
  observations: Observation[];
  open: boolean;
  onClose: () => void;
}

export function SessionSidebar({ observations, open, onClose }: SessionSidebarProps) {
  return (
    <div className={`session-sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-header">
        <h3>Session Notes</h3>
        <button className="btn btn-close" onClick={onClose}>
          &times;
        </button>
      </div>
      {observations.length === 0 ? (
        <div className="sidebar-empty">Notes will appear here as you play</div>
      ) : (
        <div className="sidebar-observations">
          {observations.map((obs) => (
            <div key={obs.id} className={`sidebar-obs priority-${obs.priority}`}>
              <div className="sidebar-obs-content">{obs.content}</div>
              <div className="sidebar-obs-meta">
                <span className={`badge-priority badge-priority-${obs.priority}`}>
                  {obs.priority}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
