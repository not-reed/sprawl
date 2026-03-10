import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Memory, GraphNode } from "../lib/types";
import { api } from "../lib/api";

interface MemoryCardProps {
  memory: Memory;
}

function nodeTypeClass(type: string) {
  const map: Record<string, string> = {
    person: "badge-node-person",
    place: "badge-node-place",
    concept: "badge-node-concept",
    event: "badge-node-event",
  };
  return map[type] ?? "badge-node-entity";
}

export function MemoryCard({ memory }: MemoryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [nodes, setNodes] = useState<GraphNode[] | null>(null);
  const navigate = useNavigate();

  const handleClick = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !nodes) {
      try {
        const res = await api.getMemoryNodes(memory.id);
        setNodes(res.nodes);
      } catch {
        setNodes([]);
      }
    }
  };

  const matchBadge = memory.matchType ? `badge badge-${memory.matchType}` : null;

  return (
    <div className={`memory-card ${expanded ? "expanded" : ""}`} onClick={handleClick}>
      <div className="memory-header">
        {matchBadge && <span className={matchBadge}>{memory.matchType}</span>}
        <span className="badge badge-category">{memory.category}</span>
        {memory.score != null && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: "auto" }}>
            {memory.score.toFixed(3)}
          </span>
        )}
      </div>
      <div className={`memory-content ${expanded ? "" : "truncated"}`}>{memory.content}</div>
      <div className="memory-meta">
        <span>{new Date(memory.created_at).toLocaleDateString()}</span>
        {memory.tags && <span>{memory.tags}</span>}
        <span style={{ marginLeft: "auto" }}>{memory.source}</span>
      </div>
      {expanded && nodes && nodes.length > 0 && (
        <div className="memory-nodes">
          {nodes.map((node) => (
            <span
              key={node.id}
              className={`badge-node ${nodeTypeClass(node.node_type)}`}
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/?node=${node.id}`);
              }}
            >
              {node.display_name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
