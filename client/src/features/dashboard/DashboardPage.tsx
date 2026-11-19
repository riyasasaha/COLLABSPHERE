import { useEffect, useState } from 'react'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type DashboardStats = {
  activeProjects: number
  pendingTasks: number
  dueToday: number
  upcomingDeadlines: number
  recentDocuments: Array<{ id: string; title: string; updatedAt: string }>
  teamActivity: Array<{ id: string; action: string; createdAt: string }>
  notifications: Array<{ id: string; title: string; description: string }>
  workspace: { id: string; name: string }
  summary: Array<{ label: string; value: string; trend: string }>
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let ignore = false

    async function load() {
      try {
        const response = await fetch(`${apiUrl}/api/dashboard`, { credentials: 'include' })
        if (!response.ok) {
          throw new Error('Unable to load dashboard')
        }
        const payload = await response.json() as DashboardStats
        if (!ignore) {
          setData(payload)
        }
      } catch (caughtError) {
        if (!ignore) {
          setError(caughtError instanceof Error ? caughtError.message : 'Dashboard unavailable')
        }
      } finally {
        if (!ignore) {
          setLoading(false)
        }
      }
    }

    void load()
    return () => {
      ignore = true
    }
  }, [])

  if (loading) return <div className="page-panel"><div className="empty-state">Loading workspace dashboard…</div></div>
  if (error) return <div className="page-panel"><div className="error-state">{error}</div></div>
  if (!data) return <div className="page-panel"><div className="empty-state">No dashboard data available.</div></div>

  return (
    <div className="page-stack">
      <section className="stat-grid">
        <article className="stat-card">
          <span>Active projects</span>
          <strong>{data.activeProjects}</strong>
        </article>
        <article className="stat-card">
          <span>Pending tasks</span>
          <strong>{data.pendingTasks}</strong>
        </article>
        <article className="stat-card">
          <span>Due today</span>
          <strong>{data.dueToday}</strong>
        </article>
        <article className="stat-card">
          <span>Upcoming deadlines</span>
          <strong>{data.upcomingDeadlines}</strong>
        </article>
      </section>

      <section className="content-grid two-column">
        <article className="panel-card">
          <header className="panel-header">
            <h3>Workspace statistics</h3>
          </header>
          <div className="mini-list">
            {data.summary.map((item) => (
              <div key={item.label} className="mini-row">
                <span>{item.label}</span>
                <div>
                  <strong>{item.value}</strong>
                  <small>{item.trend}</small>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel-card">
          <header className="panel-header">
            <h3>Notifications</h3>
          </header>
          <div className="mini-list">
            {data.notifications.length === 0 ? <div className="empty-state compact">No notifications.</div> : data.notifications.map((notice) => (
              <div key={notice.id} className="mini-row">
                <span>{notice.title}</span>
                <div>
                  <strong>{notice.description}</strong>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="content-grid three-column">
        <article className="panel-card">
          <header className="panel-header">
            <h3>Recent documents</h3>
          </header>
          <div className="mini-list">
            {data.recentDocuments.length === 0 ? <div className="empty-state compact">No recent documents.</div> : data.recentDocuments.map((doc) => (
              <div key={doc.id} className="mini-row">
                <span>{doc.title}</span>
                <div>
                  <strong>{new Date(doc.updatedAt).toLocaleDateString()}</strong>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel-card">
          <header className="panel-header">
            <h3>Team activity</h3>
          </header>
          <div className="mini-list">
            {data.teamActivity.length === 0 ? <div className="empty-state compact">No activity yet.</div> : data.teamActivity.map((activity) => (
              <div key={activity.id} className="mini-row">
                <span>{activity.action}</span>
                <div>
                  <strong>{new Date(activity.createdAt).toLocaleDateString()}</strong>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel-card">
          <header className="panel-header">
            <h3>Upcoming deadlines</h3>
          </header>
          <div className="mini-list">
            <div className="mini-row">
              <span>Workspace</span>
              <div>
                <strong>{data.workspace.name}</strong>
              </div>
            </div>
            <div className="mini-row">
              <span>Focus</span>
              <div>
                <strong>Launch operations</strong>
              </div>
            </div>
          </div>
        </article>
      </section>
    </div>
  )
}
