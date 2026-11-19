import { useEffect, useMemo, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type AnalyticsData = {
  workspace: { id: string; name: string }
  metrics: {
    projectCount: number
    taskCount: number
    completedTasks: number
    pendingTasks: number
    completionRate: number
    activeUsers: number
    documentCount: number
    fileCount: number
  }
  statusSummary: { TODO: number; IN_PROGRESS: number; DONE: number }
  activity: Array<{ id: string; action: string; actor: string; entityType: string; entityId: string; createdAt: string }>
  chart: {
    status: Array<{ label: string; value: number; color: string }>
    activity: Array<{ label: string; value: number }>
  }
}

export function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const socketRef = useRef<Socket | null>(null)

  const load = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/analytics`, { credentials: 'include' })
      if (!response.ok) throw new Error('Unable to load analytics')
      const payload = await response.json() as AnalyticsData
      setData(payload)
      setWorkspaceId(payload.workspace.id)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Analytics unavailable')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    if (!workspaceId) return

    const socket = io(apiUrl, { transports: ['websocket'], withCredentials: true })
    socketRef.current = socket
    socket.emit('workspace:join', { workspaceId })

    const handleActivityUpdate = () => {
      void load()
    }

    socket.on('workspace:activity', handleActivityUpdate)

    return () => {
      socket.off('workspace:activity', handleActivityUpdate)
      socket.emit('workspace:leave', { workspaceId })
      socket.disconnect()
      socketRef.current = null
    }
  }, [workspaceId])

  const maxStatusValue = useMemo(() => {
    if (!data) return 1
    return Math.max(...data.chart.status.map((item) => item.value), 1)
  }, [data])

  const maxActivityValue = useMemo(() => {
    if (!data) return 1
    return Math.max(...data.chart.activity.map((item) => item.value), 1)
  }, [data])

  if (loading) return <div className="page-panel"><div className="empty-state">Loading analytics…</div></div>
  if (error) return <div className="page-panel"><div className="error-state">{error}</div></div>
  if (!data) return <div className="page-panel"><div className="empty-state">No analytics data available.</div></div>

  return (
    <div className="page-stack">
      <div className="page-header-row">
        <div>
          <p className="eyebrow">ANALYTICS</p>
          <h2>{data.workspace.name}</h2>
        </div>
      </div>

      <section className="stat-grid">
        <article className="stat-card"><span>Total projects</span><strong>{data.metrics.projectCount}</strong></article>
        <article className="stat-card"><span>Total tasks</span><strong>{data.metrics.taskCount}</strong></article>
        <article className="stat-card"><span>Completed tasks</span><strong>{data.metrics.completedTasks}</strong></article>
        <article className="stat-card"><span>Pending tasks</span><strong>{data.metrics.pendingTasks}</strong></article>
      </section>

      <section className="stat-grid secondary-metrics">
        <article className="stat-card"><span>Task completion rate</span><strong>{data.metrics.completionRate}%</strong></article>
        <article className="stat-card"><span>Active workspace users</span><strong>{data.metrics.activeUsers}</strong></article>
        <article className="stat-card"><span>Total documents</span><strong>{data.metrics.documentCount}</strong></article>
        <article className="stat-card"><span>Total files</span><strong>{data.metrics.fileCount}</strong></article>
      </section>

      <section className="content-grid two-column">
        <article className="panel-card">
          <header className="panel-header"><h3>Task progress</h3></header>
          <div className="analytics-chart-list">
            {data.chart.status.map((item) => (
              <div key={item.label} className="analytics-chart-row">
                <div className="analytics-chart-meta">
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
                <div className="analytics-bar-track">
                  <div className="analytics-bar" style={{ width: `${(item.value / maxStatusValue) * 100}%`, background: item.color }} />
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel-card">
          <header className="panel-header"><h3>Activity trend</h3></header>
          <div className="activity-chart">
            {data.chart.activity.map((day) => (
              <div key={day.label} className="activity-chart-col">
                <div className="activity-chart-bar-stage">
                  {day.value > 0 && <strong className="activity-chart-value">{day.value}</strong>}
                  <div className="activity-chart-bar" style={{ height: `${Math.max((day.value / maxActivityValue) * 100, day.value > 0 ? 8 : 0)}%` }} />
                </div>
                <span>{day.label}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="content-grid two-column">
        <article className="panel-card">
          <header className="panel-header"><h3>Recent activity</h3></header>
          <div className="mini-list">
            {data.activity.length === 0 ? <div className="empty-state compact">No activity yet.</div> : data.activity.map((entry) => (
              <div key={entry.id} className="mini-row">
                <span>{entry.action}</span>
                <div>
                  <strong>{entry.actor}</strong>
                  <small>{new Date(entry.createdAt).toLocaleString()}</small>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel-card">
          <header className="panel-header"><h3>Delivery snapshot</h3></header>
          <div className="mini-list">
            <div className="mini-row"><span>To do</span><div><strong>{data.statusSummary.TODO}</strong></div></div>
            <div className="mini-row"><span>In progress</span><div><strong>{data.statusSummary.IN_PROGRESS}</strong></div></div>
            <div className="mini-row"><span>Done</span><div><strong>{data.statusSummary.DONE}</strong></div></div>
            <div className="mini-row"><span>Completion rate</span><div><strong>{data.metrics.completionRate}%</strong></div></div>
          </div>
        </article>
      </section>
    </div>
  )
}
