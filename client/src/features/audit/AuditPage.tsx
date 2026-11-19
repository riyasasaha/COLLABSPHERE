import { useEffect, useState } from 'react'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type AuditEntry = {
  id: string
  action: string
  entityType: string
  entityId: string
  createdAt: string
  actor: { id: string; name: string; email: string } | null
  metadata: Record<string, unknown> | null
}

export function AuditPage() {
  const [logs, setLogs] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch(`${apiUrl}/api/audit`, { credentials: 'include' })
        if (!response.ok) throw new Error('Unable to load audit logs')
        const payload = await response.json() as { logs?: AuditEntry[] }
        setLogs(payload.logs ?? [])
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : 'Audit logs unavailable')
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [])

  return (
    <div className="page-stack">
      <div className="page-header-row">
        <div>
          <p className="eyebrow">AUDIT LOGS</p>
          <h2>Workspace activity trail</h2>
        </div>
      </div>

      {error && <div className="error-state">{error}</div>}
      {loading ? (
        <div className="page-panel"><div className="empty-state">Loading audit history…</div></div>
      ) : logs.length === 0 ? (
        <div className="page-panel"><div className="empty-state">No activity has been logged yet.</div></div>
      ) : (
        <div className="audit-list">
          {logs.map((entry) => (
            <article key={entry.id} className="audit-card">
              <div className="audit-card-header">
                <strong>{entry.action}</strong>
                <small>{new Date(entry.createdAt).toLocaleString()}</small>
              </div>
              <p>{entry.actor ? `${entry.actor.name} • ${entry.entityType}` : entry.entityType}</p>
              {entry.metadata && <code>{JSON.stringify(entry.metadata)}</code>}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
