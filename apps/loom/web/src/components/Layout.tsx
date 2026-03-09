import { NavLink, Outlet } from 'react-router-dom'

export function Layout() {
  return (
    <div className="app">
      <nav className="nav">
        <NavLink to="/" className="nav-brand">Loom</NavLink>
        <NavLink to="/voices" className="nav-link">Voices</NavLink>
        <NavLink to="/debug/tts" className="nav-link">TTS Debug</NavLink>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
