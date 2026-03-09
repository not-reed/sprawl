import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useChat } from '../hooks/useChat'
import { useSession } from '../hooks/useSession'
import { ChatPanel } from './ChatPanel'
import { ChatInput } from './ChatInput'
import { SessionSidebar } from './SessionSidebar'

function getTtsPreference(): boolean {
  try { return localStorage.getItem('loom-tts') === '1' } catch { return false }
}

function setTtsPreference(v: boolean) {
  try { localStorage.setItem('loom-tts', v ? '1' : '0') } catch {}
}

export function PlayView() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const chat = useChat(sessionId!)
  const sessionState = useSession(sessionId!)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [ttsEnabled, setTtsEnabled] = useState(getTtsPreference)

  useEffect(() => {
    chat.loadHistory()
    sessionState.load()
  }, [sessionId])

  useEffect(() => {
    chat.setTtsEnabled(ttsEnabled)
    setTtsPreference(ttsEnabled)
  }, [ttsEnabled])

  // Refresh observations after each exchange
  useEffect(() => {
    if (!chat.isStreaming && chat.messages.length > 0) {
      sessionState.refreshObservations()
    }
  }, [chat.isStreaming, chat.messages.length])

  return (
    <div className="play-view">
      <div className="play-header">
        <div className="play-header-info">
          {sessionState.session && (
            <>
              <span className="play-title">
                {sessionState.session.name || 'Untitled Session'}
              </span>
              <button
                className={`badge badge-mode badge-${sessionState.session.mode}`}
                onClick={sessionState.toggleMode}
              >
                {sessionState.session.mode}
              </button>
            </>
          )}
        </div>
        <div className="play-header-actions">
          <button
            className={`btn btn-tts ${ttsEnabled ? 'btn-tts-on' : ''}`}
            onClick={() => setTtsEnabled(!ttsEnabled)}
            title={ttsEnabled ? 'TTS On' : 'TTS Off'}
          >
            {ttsEnabled ? '\uD83D\uDD0A' : '\uD83D\uDD07'}
          </button>
          <button
            className="btn sidebar-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? 'Hide' : 'Notes'}
          </button>
        </div>
      </div>

      <div className="play-body">
        <div className="chat-area">
          <ChatPanel
            messages={chat.messages}
            isStreaming={chat.isStreaming}
            streamingText={chat.streamingText}
            pendingAudioUrl={chat.pendingAudioUrl}
          />
          <ChatInput
            onSend={chat.sendMessage}
            disabled={chat.isStreaming}
          />
        </div>

        {sidebarOpen && (
          <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
        )}
        <SessionSidebar
          observations={sessionState.observations}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
      </div>
    </div>
  )
}
