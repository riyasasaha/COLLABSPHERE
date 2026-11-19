import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type DocumentItem = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  author: {
    id: string
    name: string
    avatarUrl?: string | null
  }
  _count?: {
    versions: number
    comments: number
  }
}

export function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentItem[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const loadDocuments = async () => {
    setLoading(true)
    try {
      const response = await fetch(`${apiUrl}/api/documents`, { credentials: 'include' })
      if (!response.ok) {
        throw new Error('Unable to load documents')
      }
      const payload = await response.json() as { documents?: DocumentItem[] }
      setDocuments(payload.documents ?? [])
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Documents unavailable')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadDocuments()
  }, [])

  const handleCreateDocument = async () => {
    setCreating(true)
    setError('')
    try {
      const response = await fetch(`${apiUrl}/api/documents`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Untitled document' }),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? 'Unable to create document')
      }

      const payload = await response.json() as { document: { id: string } }
      navigate(`/documents/${payload.document.id}`)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to create document')
      setCreating(false)
    }
  }

  const handleDeleteDocument = async (id: string, title: string, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!confirm(`Are you sure you want to delete "${title}"?`)) return

    try {
      const response = await fetch(`${apiUrl}/api/documents/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Unable to delete document')
      setDocuments((prev) => prev.filter((doc) => doc.id !== id))
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to delete document')
    }
  }

  const filteredDocuments = documents.filter((doc) =>
    doc.title.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="page-stack">
      <div className="page-header-row">
        <div>
          <p className="eyebrow">WORKSPACE KNOWLEDGE BASE</p>
          <h2>Collaborative Documents</h2>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => { void handleCreateDocument() }}
            disabled={creating}
          >
            {creating ? '+ Creating…' : '+ New Document'}
          </button>
        </div>
      </div>

      <div className="doc-toolbar">
        <div className="doc-search-wrap">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documents by title..."
            className="doc-search-input"
          />
        </div>
        <span className="doc-count-pill">
          {filteredDocuments.length} {filteredDocuments.length === 1 ? 'document' : 'documents'}
        </span>
      </div>

      {error && <div className="error-state">{error}</div>}

      {loading ? (
        <div className="page-panel">
          <div className="empty-state">Loading workspace documents…</div>
        </div>
      ) : filteredDocuments.length === 0 ? (
        <div className="page-panel doc-empty-panel">
          <div className="doc-empty-icon">📄</div>
          <h3>{search ? 'No matching documents found' : 'No documents yet in this workspace'}</h3>
          <p>Create your first real-time collaborative document to share notes, launch plans, and technical specs.</p>
          <button
            type="button"
            className="primary-button small"
            onClick={() => { void handleCreateDocument() }}
            disabled={creating}
          >
            + Create New Document
          </button>
        </div>
      ) : (
        <div className="doc-grid">
          {filteredDocuments.map((doc) => (
            <Link key={doc.id} to={`/documents/${doc.id}`} className="doc-card">
              <div className="doc-card-header">
                <div className="doc-card-main">
                  <div className="doc-card-icon" aria-hidden="true">📄</div>
                  <div className="doc-card-copy">
                    <strong className="doc-card-title">{doc.title}</strong>
                    <div className="doc-card-meta">
                      <span className="doc-author">
                        <span className="author-dot" aria-hidden="true" />
                        {doc.author?.name || 'Workspace member'}
                      </span>
                      <span className="doc-meta-separator">•</span>
                      <span className="doc-date">
                        Updated {new Date(doc.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                      <span className="doc-meta-separator">•</span>
                      <span className="doc-version-label">v{doc._count?.versions ?? 1}</span>
                    </div>
                  </div>
                </div>

                <div className="doc-card-badges">
                  {(doc._count?.comments ?? 0) > 0 && (
                    <span className="doc-comment-pill">💬 {doc._count?.comments}</span>
                  )}
                </div>
              </div>

              <div className="doc-card-footer">
                <span className="doc-open-link">Open editor →</span>
                <button
                  type="button"
                  className="doc-delete-btn"
                  title="Delete document"
                  aria-label={`Delete ${doc.title}`}
                  onClick={(e) => { void handleDeleteDocument(doc.id, doc.title, e) }}
                >
                  Delete
                </button>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
