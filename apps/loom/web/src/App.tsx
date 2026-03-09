import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { CampaignList } from './components/CampaignList'
import { CampaignView } from './components/CampaignView'
import { PlayView } from './components/PlayView'
import { VoiceSettings } from './components/VoiceSettings'
import { TtsDebug } from './components/TtsDebug'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<CampaignList />} />
          <Route path="/campaign/:id" element={<CampaignView />} />
          <Route path="/play/:sessionId" element={<PlayView />} />
          <Route path="/voices" element={<VoiceSettings />} />
          <Route path="/debug/tts" element={<TtsDebug />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
