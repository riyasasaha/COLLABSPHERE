import { useEffect, useMemo, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type ChatMessage = {
  id: string
  channel: string
  body: string
  createdAt: string
  sender: { id: string; name: string; email: string; avatarUrl?: string | null }
}

type CurrentUser = {
  id: string
  name: string
  email: string
}

function formatMessageBody(body: string) {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  return escaped.replace(/@([A-Za-z0-9_]+)/g, '<span class="chat-mention">@$1</span>')
}

export function ChatPage() {
  const [channel, setChannel] = useState('general')
  const [workspaceId, setWorkspaceId] = useState<string>('')
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [typingUser, setTypingUser] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const socketRef = useRef<Socket | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const loadCurrentUser = async () => {
      try {
        const response = await fetch(`${apiUrl}/auth/me`, { credentials: 'include' })
        if (response.ok) {
          const payload = await response.json() as { user?: CurrentUser }
          setCurrentUser(payload.user ?? null)
        }
      } catch {
        // ignore and continue with a blank user identity on the client
      }
    }

    const loadWorkspace = async () => {
      try {
        const response = await fetch(`${apiUrl}/api/dashboard`, { credentials: 'include' })
        if (response.ok) {
          const payload = await response.json() as { workspace?: { id: string } }
          if (payload.workspace?.id) {
            setWorkspaceId(payload.workspace.id)
          }
        }
      } catch {
        // ignore; the room will still work using the dashboard workspace ID if it loads later.
      }
    }

    void loadCurrentUser()
    void loadWorkspace()
  }, [])

  const loadMessages = async (nextChannel = channel, nextWorkspaceId = workspaceId) => {
    if (!nextWorkspaceId) return
    setLoading(true)
    try {
      const response = await fetch(`${apiUrl}/api/chat?channel=${encodeURIComponent(nextChannel)}`, { credentials: 'include' })
      if (!response.ok) throw new Error('Unable to load chat messages')
      const payload = await response.json() as { messages?: ChatMessage[] }
      setMessages(payload.messages ?? [])
      setError('')
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Chat unavailable')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!workspaceId) return
    void loadMessages(channel, workspaceId)
  }, [channel, workspaceId])

  useEffect(() => {
    if (!workspaceId) return

    const socket = io(apiUrl, { transports: ['websocket'], withCredentials: true })
    socketRef.current = socket
    socket.emit('chat:join', { workspaceId, channel })

    socket.on('chat:new_message', (message: ChatMessage) => {
      if (message.channel !== channel) return
      setMessages((prev) => {
        const exists = prev.some((item) => item.id === message.id)
        return exists ? prev : [...prev, message]
      })
    })

    socket.on('chat:typing', (payload: { user?: { name?: string }; isTyping?: boolean; channel?: string }) => {
      if (payload.channel !== channel) return
      if (payload.isTyping && payload.user?.name) {
        setTypingUser(payload.user.name)
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
        typingTimeoutRef.current = setTimeout(() => {
          setTypingUser(null)
        }, 1800)
        return
      }
      setTypingUser(null)
    })

    return () => {
      socket.emit('chat:leave', { workspaceId, channel })
      socket.disconnect()
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    }
  }, [channel, workspaceId])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, channel])

  const handleTyping = () => {
    if (!socketRef.current || !workspaceId || !currentUser?.name) return
    socketRef.current.emit('chat:typing', {
      workspaceId,
      channel,
      user: { id: currentUser.id, name: currentUser.name },
      isTyping: true,
    })
  }

  const sendMessage = async () => {
    const trimmed = draft.trim()
    if (!trimmed || !workspaceId) return

    try {
      const response = await fetch(`${apiUrl}/api/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, body: trimmed }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? 'Unable to send message')
      }
      setDraft('')
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to send message')
    }
  }

  const channels = useMemo(() => ['general', 'design', 'build', 'launch'], [])

  return (
    <div className="page-stack">
      <div className="page-header-row">
        <div>
          <p className="eyebrow">TEAM CHAT</p>
          <h2>Workspace messaging</h2>
        </div>
      </div>

      <div className="chat-shell">
        <aside className="chat-sidebar">
          {channels.map((entry) => (
            <button
              key={entry}
              type="button"
              className={`chat-channel ${entry === channel ? 'active' : ''}`}
              onClick={() => setChannel(entry)}
            >
              # {entry}
            </button>
          ))}
        </aside>

        <section className="chat-panel">
          {error && <div className="error-state">{error}</div>}
          {loading ? (
            <div className="empty-state">Loading chat…</div>
          ) : (
            <div className="chat-message-list">
              {messages.length === 0 ? (
                <div className="empty-state compact">No messages yet in #{channel}.</div>
              ) : (
                messages.map((message) => (
                  <article key={message.id} className="chat-message">
                    <div className="chat-avatar">{message.sender.name.charAt(0).toUpperCase()}</div>
                    <div className="chat-bubble">
                      <div className="chat-meta">
                        <strong>{message.sender.name}</strong>
                        <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <p dangerouslySetInnerHTML={{ __html: formatMessageBody(message.body) }} />
                    </div>
                  </article>
                ))
              )}
              {typingUser && (
                <div className="chat-typing-indicator">
                  <span className="typing-pulse" />
                  {typingUser} is typing…
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}

          <div className="chat-composer">
            <textarea
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                handleTyping()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendMessage()
                }
              }}
              rows={3}
              placeholder={`Message #${channel}`}
            />
            <div className="chat-compose-actions">
              <span className="chat-channel-tag">#{channel}</span>
              <button type="button" className="primary-button small" onClick={() => { void sendMessage() }} disabled={!draft.trim() || !workspaceId}>Send</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
