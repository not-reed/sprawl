import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { GraphView } from './components/GraphView'
import { MemoryBrowser } from './components/MemoryBrowser'
import { ObservationTimeline } from './components/ObservationTimeline'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<GraphView />} />
          <Route path="/memories" element={<MemoryBrowser />} />
          <Route path="/observations" element={<ObservationTimeline />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
