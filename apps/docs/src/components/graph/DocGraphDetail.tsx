import type { DocNode, DocEdge } from './types'
import { getNodeColor } from './graph-layout'

interface DocGraphDetailProps {
  node: DocNode
  edges: DocEdge[]
  pages: string[]
  allNodeNames: Map<string, { display_name: string; node_type: string }>
  onSelectNode: (id: string) => void
  onClose: () => void
}

function pageToUrl(slug: string): string {
  return `/${slug}/`
}

function pageLabel(slug: string): string {
  return slug.split('/').pop() ?? slug
}

export function DocGraphDetail({
  node,
  edges,
  pages,
  allNodeNames,
  onSelectNode,
  onClose,
}: DocGraphDetailProps) {
  const color = getNodeColor(node.node_type)

  return (
    <div
      style={{
        width: 280,
        background: 'rgba(18, 18, 26, 0.95)',
        borderLeft: '1px solid rgba(124, 108, 240, 0.2)',
        padding: 16,
        overflowY: 'auto',
        fontSize: 13,
        color: '#e4e4ef',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color }}>{node.display_name}</div>
          <div style={{ fontSize: 11, color: '#9898a8', marginTop: 2 }}>{node.node_type}</div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: '1px solid rgba(124, 108, 240, 0.2)',
            borderRadius: 3,
            color: '#9898a8',
            cursor: 'pointer',
            padding: '2px 8px',
            fontSize: 14,
          }}
        >
          &times;
        </button>
      </div>

      {node.description && (
        <p style={{ marginTop: 8, fontSize: 12, color: '#c8c8d8' }}>
          {node.description}
        </p>
      )}

      {edges.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ fontSize: 12, color: '#9898a8', margin: '0 0 8px' }}>
            Connections ({edges.length})
          </h4>
          {edges.map((edge) => {
            const otherId = edge.source_id === node.id ? edge.target_id : edge.source_id
            const other = allNodeNames.get(otherId)
            return (
              <div
                key={edge.id}
                onClick={() => onSelectNode(otherId)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 0',
                  cursor: 'pointer',
                  borderBottom: '1px solid rgba(60, 60, 80, 0.3)',
                }}
              >
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: other ? getNodeColor(other.node_type) : '#686878',
                  flexShrink: 0,
                }} />
                <span style={{ flex: 1 }}>{other?.display_name ?? otherId}</span>
                <span style={{ fontSize: 10, color: '#686878' }}>{edge.relation}</span>
                <span style={{ fontSize: 10, color: '#686878' }}>w:{edge.weight}</span>
              </div>
            )
          })}
        </div>
      )}

      {pages.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ fontSize: 12, color: '#9898a8', margin: '0 0 8px' }}>
            Appears in ({pages.length} pages)
          </h4>
          {pages.map((slug) => (
            <a
              key={slug}
              href={pageToUrl(slug)}
              style={{
                display: 'block',
                padding: '4px 0',
                color: '#7c6cf0',
                textDecoration: 'none',
                fontSize: 12,
                borderBottom: '1px solid rgba(60, 60, 80, 0.2)',
              }}
            >
              {slug}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
