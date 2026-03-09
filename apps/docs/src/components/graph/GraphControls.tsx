import { getNodeColor, NODE_TYPES } from './graph-layout'

interface GraphControlsProps {
  typeFilters: Set<string>
  onToggleType: (type: string) => void
  onReset: () => void
  onSearch: (query: string) => void
}

export function GraphControls({
  typeFilters,
  onToggleType,
  onReset,
  onSearch,
}: GraphControlsProps) {
  return (
    <div style={{
      position: 'absolute',
      top: 8,
      left: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      zIndex: 10,
    }}>
      <input
        type="text"
        placeholder="Search nodes..."
        style={{
          padding: '6px 10px',
          background: 'rgba(18, 18, 26, 0.9)',
          border: '1px solid rgba(124, 108, 240, 0.3)',
          borderRadius: 4,
          color: '#e4e4ef',
          fontSize: 13,
          outline: 'none',
          width: 180,
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onSearch((e.target as HTMLInputElement).value)
          }
        }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {NODE_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => onToggleType(type)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 8px',
              background: typeFilters.has(type) ? 'rgba(18, 18, 26, 0.9)' : 'rgba(18, 18, 26, 0.4)',
              border: '1px solid rgba(124, 108, 240, 0.2)',
              borderRadius: 3,
              color: typeFilters.has(type) ? '#e4e4ef' : '#68687888',
              fontSize: 11,
              cursor: 'pointer',
              opacity: typeFilters.has(type) ? 1 : 0.5,
            }}
          >
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: getNodeColor(type),
            }} />
            {type}
          </button>
        ))}
        <button
          onClick={onReset}
          style={{
            padding: '3px 8px',
            background: 'rgba(18, 18, 26, 0.9)',
            border: '1px solid rgba(124, 108, 240, 0.2)',
            borderRadius: 3,
            color: '#e4e4ef',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Reset
        </button>
      </div>
    </div>
  )
}
