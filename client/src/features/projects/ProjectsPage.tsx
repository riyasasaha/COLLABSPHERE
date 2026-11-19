import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type Board = {
  id: string
  name: string
  description?: string | null
  createdAt: string
  _count?: { tasks: number }
}

export function ProjectsPage() {
  const [boards, setBoards] = useState<Board[]>([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadBoards = async () => {
    setLoading(true)
    try {
      const response = await fetch(`${apiUrl}/api/boards`, { credentials: 'include' })
      if (!response.ok) {
        throw new Error('Unable to load projects')
      }
      const payload = await response.json() as { boards?: Board[] }
      setBoards(payload.boards ?? [])
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Projects unavailable')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadBoards()
  }, [])

  const createBoard = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return

    try {
      const response = await fetch(`${apiUrl}/api/boards`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, description }),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? 'Unable to create project')
      }

      setName('')
      setDescription('')
      await loadBoards()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to create project')
    }
  }

  return (
    <div className="page-stack">
      <div className="page-header-row">
        <div>
          <p className="eyebrow">PROJECTS</p>
          <h2>Workspace initiatives</h2>
        </div>
      </div>

      <form className="project-form" onSubmit={createBoard}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" />
        <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Short description" />
        <button type="submit" className="primary-button small">Create project</button>
      </form>

      {error && <div className="error-state">{error}</div>}

      {loading ? <div className="page-panel"><div className="empty-state">Loading projects…</div></div> : (
        <section className="project-grid">
          {boards.length === 0 ? <div className="page-panel"><div className="empty-state">No projects yet for this workspace.</div></div> : boards.map((board) => (
            <Link key={board.id} to={`/projects/${board.id}`} className="project-card">
              <div className="project-card-top">
                <span className="project-pill">ACTIVE</span>
                <strong>{board.name}</strong>
              </div>
              <p>{board.description || 'No description provided yet.'}</p>
              <div className="project-card-meta">
                <span>{board._count?.tasks ?? 0} tasks</span>
                <span>{new Date(board.createdAt).toLocaleDateString()}</span>
              </div>
            </Link>
          ))}
        </section>
      )}
    </div>
  )
}
