import { useEffect, useRef, useCallback } from 'react'
import { ChatMessage } from './ChatMessage'
import { api } from '../lib/api'
import type { Message } from '../lib/types'

interface ChatPanelProps {
  messages: Message[]
  isStreaming: boolean
  streamingText: string
  pendingAudioUrl?: string | null
}

export function ChatPanel({ messages, isStreaming, streamingText, pendingAudioUrl }: ChatPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  // Find the last assistant message index to attach pending audio URL
  let lastGmIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastGmIdx = i; break }
  }

  const makeGenerateAudio = useCallback((text: string) => {
    return async (): Promise<string | null> => {
      try {
        const { url } = await api.generateAudio(text)
        return url
      } catch {
        return null
      }
    }
  }, [])

  return (
    <div className="chat-panel">
      {messages.length === 0 && !isStreaming && (
        <div className="empty-state">
          <div className="empty-state-title">Ready to play</div>
          <div>Send a message to begin your adventure</div>
        </div>
      )}
      {messages.map((msg, i) => (
        <ChatMessage
          key={msg.id}
          message={msg}
          audioUrl={i === lastGmIdx ? (pendingAudioUrl ?? undefined) : undefined}
          onGenerateAudio={msg.role === 'assistant' ? makeGenerateAudio(msg.content) : undefined}
        />
      ))}
      {isStreaming && streamingText && (
        <ChatMessage
          message={{
            id: 'streaming',
            conversation_id: '',
            role: 'assistant',
            content: streamingText,
            tool_calls: null,
            created_at: new Date().toISOString(),
          }}
        />
      )}
      <div ref={bottomRef} />
    </div>
  )
}
