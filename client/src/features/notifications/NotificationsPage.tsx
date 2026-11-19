import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type NotificationItem = {
  id: string
  type: string
  title: string
  description: string
  createdAt: string
  read: boolean
}

export function NotificationsPage() {
  const [items, setItems] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const socketRef = useRef<Socket | null>(null)

  const loadNotifications = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/notifications`, { credentials: 'include' })
      if (!response.ok) throw new Error('Unable to load notifications')
      const payload = await response.json() as { notifications?: NotificationItem[] }
      setItems(payload.notifications ?? [])
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Notifications unavailable')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadNotifications()
  }, [])

  useEffect(() => {
    const loadCurrentUser = async () => {
      try {
        const response = await fetch(`${apiUrl}/auth/me`, { credentials: 'include' })
        if (!response.ok) return
        const payload = await response.json() as { user?: { id?: string } }
        if (payload.user?.id) {
          setCurrentUserId(payload.user.id)
        }
      } catch {
        // ignore session load errors
      }
    }

    void loadCurrentUser()
  }, [])

  useEffect(() => {
    if (!currentUserId) return

    const socket = io(apiUrl, { transports: ['websocket'], withCredentials: true })
    socketRef.current = socket
    socket.emit('user:join', { userId: currentUserId })

    const handleNotificationNew = (payload: { notification?: NotificationItem }) => {
      const incoming = payload.notification
      if (!incoming) return
      setItems((previous) => [incoming, ...previous.filter((item) => item.id !== incoming.id)])
    }

    const handleNotificationUpdated = (payload: { notification?: NotificationItem; allRead?: boolean }) => {
      if (payload.allRead) {
        setItems((previous) => previous.map((item) => ({ ...item, read: true })))
        return
      }

      if (payload.notification) {
        setItems((previous) => previous.map((item) => item.id === payload.notification!.id ? { ...item, ...payload.notification! } : item))
      }
    }

    socket.on('notifications:new', handleNotificationNew)
    socket.on('notifications:updated', handleNotificationUpdated)

    return () => {
      socket.off('notifications:new', handleNotificationNew)
      socket.off('notifications:updated', handleNotificationUpdated)
      socket.emit('user:leave', { userId: currentUserId })
      socket.disconnect()
      socketRef.current = null
    }
  }, [currentUserId])

  const markAsRead = async (notificationId: string) => {
    try {
      const response = await fetch(`${apiUrl}/api/notifications/${notificationId}/read`, {
        method: 'PATCH',
        credentials: 'include',
      })
      if (!response.ok) return
      setItems((current) => current.map((item) => item.id === notificationId ? { ...item, read: true } : item))
    } catch {
      // ignore mark-as-read errors
    }
  }

  const markAllRead = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/notifications/read-all`, {
        method: 'PATCH',
        credentials: 'include',
      })
      if (!response.ok) return
      setItems((current) => current.map((item) => ({ ...item, read: true })))
    } catch {
      // ignore mark-all-read errors
    }
  }

  return (
    <div className="page-stack">
      <div className="page-header-row">
        <div>
          <p className="eyebrow">ALERTS</p>
          <h2>Workspace notifications</h2>
        </div>
        {items.some((item) => !item.read) && (
          <button type="button" className="secondary-button small" onClick={() => { void markAllRead() }}>
            Mark all read
          </button>
        )}
      </div>

      {error && <div className="error-state">{error}</div>}
      {loading ? (
        <div className="page-panel"><div className="empty-state">Loading notifications…</div></div>
      ) : items.length === 0 ? (
        <div className="page-panel"><div className="empty-state">No notifications for this workspace.</div></div>
      ) : (
        <div className="notification-list">
          {items.map((item) => (
            <article key={item.id} className={`notification-card ${item.read ? 'read' : ''}`}>
              <div className="notification-header">
                <span className="notification-tag">{item.type}</span>
                <small>{new Date(item.createdAt).toLocaleString()}</small>
              </div>
              <strong>{item.title}</strong>
              <p>{item.description}</p>
              {!item.read && (
                <div className="notification-card-actions">
                  <button type="button" className="secondary-button small" onClick={() => { void markAsRead(item.id) }}>
                    Mark read
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
