import { useState } from 'react'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'
const workspaceId = 'workspace-demo-01'

type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

type AssistantPanelProps = {
  isOpen?: boolean
  onClose?: () => void
  documentContext?: { title?: string; content?: string }
}

export function AssistantPanel({ isOpen, onClose, documentContext }: AssistantPanelProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = isOpen !== undefined ? isOpen : internalOpen
  const handleClose = () => {
    if (onClose) onClose()
    else setInternalOpen(false)
  }
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: 'I can summarize your launch priorities, review task health, analyze open documents, and propose next steps for this workspace.',
    },
  ])

  const askAssistant = async (query: string) => {
    const trimmed = query.trim()
    if (!trimmed || loading) return

    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: 'user', text: trimmed }])
    setInput('')
    setLoading(true)

    const docSummaries = documentContext?.title
      ? [`Active Document: "${documentContext.title}" — Preview: ${documentContext.content?.replace(/<[^>]*>/g, ' ').slice(0, 600) || 'empty content'}`]
      : ['Launch strategy brief']

    try {
      const response = await fetch(`${apiUrl}/api/assistant/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          query: trimmed,
          context: {
            workspaceId,
            focus: documentContext?.title ? `Document review: ${documentContext.title}` : 'Launch operations',
            documents: docSummaries,
            tasks: [{ title: 'Finalize launch narratives', status: 'In review' }],
            notes: ['Prioritize onboarding clarity'],
          },
        }),
      })

      if (!response.ok) {
        throw new Error('Assistant request failed')
      }

      const payload = await response.json() as { response?: string }
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: 'assistant', text: payload.response ?? 'No response returned.' }])
    } catch (error) {
      setMessages((current) => [...current, { id: `assistant-error-${Date.now()}`, role: 'assistant', text: error instanceof Error ? error.message : 'The AI assistant is unavailable.' }])
    } finally {
      setLoading(false)
    }
  }

  const suggestionPrompts = documentContext?.title
    ? ['Summarize this document', 'Review clarity and tone', 'Suggest next steps', 'Review task health']
    : ['Summarize blockers', 'Review task health', 'Brainstorm launch ideas']

  return (
    <aside className={`assistant-drawer ${open ? 'open' : ''}`} aria-label="AI Copilot drawer">
      <div className="assistant-panel">
        <header className="assistant-header">
          <div>
            <p className="eyebrow">AI COPILOT</p>
            <h2>Workspace copilot</h2>
          </div>
          <button type="button" className="drawer-close" onClick={handleClose} aria-label="Close AI assistant">×</button>
        </header>

        <div className="assistant-suggestions">
          {suggestionPrompts.map((prompt) => (
            <button key={prompt} type="button" className="suggestion-chip" onClick={() => setInput(prompt)}>
              {prompt}
            </button>
          ))}
        </div>

        <div className="assistant-conversation">
          {messages.map((message) => (
            <div key={message.id} className={`message-row ${message.role}`}>
              <div className="message-bubble">{message.text}</div>
            </div>
          ))}
          {loading && (
            <div className="message-row assistant">
              <div className="message-bubble typing"><span /><span /><span /></div>
            </div>
          )}
        </div>

        <form
          className="assistant-input-row"
          onSubmit={(event) => {
            event.preventDefault()
            void askAssistant(input)
          }}
        >
          <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about tasks, docs, or ideas…" />
          <button type="submit" className="primary-button small" disabled={loading || !input.trim()}>
            {loading ? 'Thinking…' : 'Send'}
          </button>
        </form>
      </div>
    </aside>
  )
}
