import { getNodeColor } from '../lib/graph-layout'

interface GraphControlsProps {
  typeFilters: Set<string>
  onToggleType: (type: string) => void
  onReset: () => void
  onSearch: (query: string) => void
}

const NODE_TYPES = ['person', 'place', 'concept', 'event', 'entity']

export function GraphControls({
  typeFilters,
  onToggleType,
  onReset,
  onSearch,
}: GraphControlsProps) {
  return (
    <div className="graph-controls">
      <div className="search-bar">
        <input
          className="search-input"
          type="text"
          placeholder="Search nodes..."
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onSearch((e.target as HTMLInputElement).value)
            }
          }}
        />
      </div>
      <div className="graph-filter-group">
        {NODE_TYPES.map((type) => (
          <label
            key={type}
            className={`graph-filter ${typeFilters.has(type) ? '' : 'inactive'}`}
            onClick={() => onToggleType(type)}
          >
            <span
              className="graph-filter-dot"
              style={{ background: getNodeColor(type) }}
            />
            {type}
          </label>
        ))}
        <button className="btn" onClick={onReset} style={{ marginLeft: 4 }}>
          Reset
        </button>
      </div>
    </div>
  )
}
