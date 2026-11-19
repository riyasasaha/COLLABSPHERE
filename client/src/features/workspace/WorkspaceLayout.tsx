import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { io, type Socket } from 'socket.io-client'
import { AssistantPanel } from '../assistant/AssistantPanel'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type NotificationItem = {
  id: string
  type: string
  title: string
  description: string
  createdAt: string
  read: boolean
  actor?: { id: string; name: string; avatarUrl?: string | null } | null
}

type WorkspaceLayoutProps = {
  user: { id: string; email: string; name: string }
  onLogout: () => Promise<void>
}

const navItems = [
  { to: '/', label: 'Dashboard' },
  { to: '/projects', label: 'Projects' },
  { to: '/documents', label: 'Documents' },
  { to: '/chat', label: 'Chat' },
  { to: '/files', label: 'Files' },
  { to: '/notifications', label: 'Notifications' },
  { to: '/huddle', label: 'Huddle' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/audit', label: 'Audit' },
  { to: '/settings', label: 'Settings' },
]

export function WorkspaceLayout({ user, onLogout }: WorkspaceLayoutProps) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const socketRef = useRef<Socket | null>(null)

  const loadNotifications = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/notifications`, { credentials: 'include' })
      if (!response.ok) return
      const payload = await response.json() as { notifications?: NotificationItem[] }
      setNotifications(payload.notifications ?? [])
    } catch {
      // Ignore notification load failures for the shell; they are non-blocking.
    }
  }

  useEffect(() => {
    void loadNotifications()
  }, [])

  useEffect(() => {
    const loadWorkspace = async () => {
      try {
        const response = await fetch(`${apiUrl}/api/dashboard`, { credentials: 'include' })
        if (!response.ok) return
        const payload = await response.json() as { workspace?: { id: string } }
        if (payload.workspace?.id) {
          setWorkspaceId(payload.workspace.id)
        }
      } catch {
        // Ignore workspace read errors; the notification room will not be joined until data loads.
      }
    }

    void loadWorkspace()
  }, [])

  useEffect(() => {
    if (!workspaceId || !user?.id) return

    const socket = io(apiUrl, { transports: ['websocket'], withCredentials: true })
    socketRef.current = socket
    socket.emit('workspace:join', { workspaceId })
    socket.emit('user:join', { userId: user.id })

    const handleNotificationNew = (payload: { notification?: NotificationItem }) => {
      const incoming = payload.notification
      if (!incoming) return
      setNotifications((previous) => [incoming, ...previous.filter((item) => item.id !== incoming.id)])
    }

    const handleNotificationUpdated = (payload: { notification?: NotificationItem; allRead?: boolean; count?: number }) => {
      if (payload.allRead) {
        setNotifications((previous) => previous.map((item) => ({ ...item, read: true })))
        return
      }
      if (payload.notification) {
        setNotifications((previous) => previous.map((item) => item.id === payload.notification!.id ? { ...item, ...payload.notification! } : item))
      }
    }

    socket.on('notifications:new', handleNotificationNew)
    socket.on('notifications:updated', handleNotificationUpdated)

    return () => {
      socket.off('notifications:new', handleNotificationNew)
      socket.off('notifications:updated', handleNotificationUpdated)
      socket.emit('workspace:leave', { workspaceId })
      socket.emit('user:leave', { userId: user.id })
      socket.disconnect()
      socketRef.current = null
    }
  }, [workspaceId, user.id])

  const unreadCount = useMemo(() => notifications.filter((item) => !item.read).length, [notifications])

  const markAsRead = async (notificationId: string) => {
    try {
      const response = await fetch(`${apiUrl}/api/notifications/${notificationId}/read`, {
        method: 'PATCH',
        credentials: 'include',
      })
      if (!response.ok) return
      setNotifications((previous) => previous.map((item) => item.id === notificationId ? { ...item, read: true } : item))
    } catch {
      // ignore update errors
    }
  }

  const markAllRead = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/notifications/read-all`, {
        method: 'PATCH',
        credentials: 'include',
      })
      if (!response.ok) return
      setNotifications((previous) => previous.map((item) => ({ ...item, read: true })))
    } catch {
      // ignore update errors
    }
  }

  return (
    <div className="workspace-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">C</div>
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <h2>COLLABSPHERE</h2>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }: { isActive: boolean }) => `nav-item ${isActive ? 'active' : ''}`}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-badge">
            <span>{user.name.charAt(0).toUpperCase()}</span>
            <div>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </div>
          </div>
          <button type="button" className="secondary-button" onClick={() => { void onLogout() }}>
            Log out
          </button>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">ENTERPRISE COMMAND CENTER</p>
            <h1>Operations Dashboard</h1>
          </div>
          <div className="topbar-actions">
            <Link to="/search" className="secondary-button topbar-link">Search</Link>
            <div className="notification-menu-wrap">
              <button
                type="button"
                className="primary-button small topbar-link notification-trigger"
                onClick={() => setIsNotificationsOpen((previous) => !previous)}
              >
                Notifications
                {unreadCount > 0 && <span className="notification-badge">{unreadCount}</span>}
              </button>

              {isNotificationsOpen && (
                <div className="notification-popover">
                  <div className="notification-popover-header">
                    <strong>Alerts</strong>
                    <button type="button" className="tiny-button" onClick={() => { void markAllRead() }}>Mark all read</button>
                  </div>
                  {notifications.length === 0 ? (
                    <div className="empty-state compact">No notifications yet.</div>
                  ) : (
                    <div className="notification-popover-list">
                      {notifications.slice(0, 6).map((notification) => (
                        <button
                          key={notification.id}
                          type="button"
                          className={`notification-popover-item ${notification.read ? 'read' : 'unread'}`}
                          onClick={() => {
                            if (!notification.read) {
                              void markAsRead(notification.id)
                            }
                            setIsNotificationsOpen(false)
                          }}
                        >
                          <div className="notification-popover-meta">
                            <span className="notification-tag small-tag">{notification.type}</span>
                            {!notification.read && <span className="unread-dot" />}
                          </div>
                          <strong>{notification.title}</strong>
                          <p>{notification.description}</p>
                          <small>{new Date(notification.createdAt).toLocaleString()}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="content-shell">
          <Outlet />
        </main>
      </div>

      <AssistantPanel />
    </div>
  )
}
