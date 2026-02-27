import { NavLink, Outlet } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { api } from '../lib/api'

export function Layout() {
  const { data: stats } = useApi(() => api.getStats(), [])

  return (
    <div className="app">
      <nav className="nav">
        <span className="nav-brand">construct</span>
        <div className="nav-links">
          <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            Graph
          </NavLink>
          <NavLink to="/memories" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            Memories
          </NavLink>
          <NavLink to="/observations" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            Observations
          </NavLink>
        </div>
        {stats && (
          <div className="nav-stats">
            <div className="nav-stat">
              <span className="nav-stat-value">{stats.memories}</span> memories
            </div>
            <div className="nav-stat">
              <span className="nav-stat-value">{stats.nodes}</span> nodes
            </div>
            <div className="nav-stat">
              <span className="nav-stat-value">{stats.edges}</span> edges
            </div>
            <div className="nav-stat">
              <span className="nav-stat-value">{stats.observations}</span> observations
            </div>
          </div>
        )}
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
