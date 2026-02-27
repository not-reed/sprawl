import { useNavigate } from 'react-router-dom'
import type { GraphNode, GraphEdge, Memory } from '../lib/types'
import { getNodeColor } from '../lib/graph-layout'

interface GraphDetailProps {
  node: GraphNode
  edges: GraphEdge[]
  memories: Memory[]
  allNodeNames: Map<string, { display_name: string; node_type: string }>
  onSelectNode: (id: string) => void
  onClose: () => void
}

export function GraphDetail({
  node,
  edges,
  memories,
  allNodeNames,
  onSelectNode,
  onClose,
}: GraphDetailProps) {
  const navigate = useNavigate()

  const color = getNodeColor(node.node_type)

  return (
    <div className="graph-detail">
      <div className="graph-detail-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="graph-detail-name" style={{ color }}>{node.display_name}</div>
            <div className="graph-detail-type">{node.node_type}</div>
          </div>
          <button className="btn" onClick={onClose} style={{ fontSize: 14, padding: '2px 8px' }}>
            &times;
          </button>
        </div>
        {node.description && (
          <p style={{ marginTop: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
            {node.description}
          </p>
        )}
      </div>

      {edges.length > 0 && (
        <div className="graph-detail-section">
          <h4>Connections ({edges.length})</h4>
          {edges.map((edge) => {
            const otherId =
              edge.source_id === node.id ? edge.target_id : edge.source_id
            const other = allNodeNames.get(otherId)
            return (
              <div
                key={edge.id}
                className="graph-edge-item"
                onClick={() => onSelectNode(otherId)}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: other
                      ? getNodeColor(other.node_type)
                      : 'var(--gray)',
                    flexShrink: 0,
                  }}
                />
                <span>{other?.display_name ?? otherId}</span>
                <span className="graph-edge-relation">{edge.relation}</span>
                <span className="graph-edge-weight">
                  w:{edge.weight}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {memories.length > 0 && (
        <div className="graph-detail-section">
          <h4>Linked Memories ({memories.length})</h4>
          {memories.map((m) => (
            <div
              key={m.id}
              className="memory-card"
              style={{ marginBottom: 6, cursor: 'pointer' }}
              onClick={() => navigate(`/memories?highlight=${m.id}`)}
            >
              <div className="memory-content truncated" style={{ fontSize: 12 }}>
                {m.content}
              </div>
              <div className="memory-meta">
                <span className="badge badge-category">{m.category}</span>
                <span>{new Date(m.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
