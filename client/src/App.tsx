import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthPage } from './features/auth/AuthPage'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { HuddlePage } from './features/huddle/HuddlePage'
import { ProjectsPage } from './features/projects/ProjectsPage'
import { BoardPage } from './features/projects/BoardPage'
import { DocumentsPage } from './features/documents/DocumentsPage'
import { DocumentEditorPage } from './features/documents/DocumentEditorPage'
import { ChatPage } from './features/chat/ChatPage'
import { FilesPage } from './features/files/FilesPage'
import { NotificationsPage } from './features/notifications/NotificationsPage'
import { SearchPage } from './features/search/SearchPage'
import { AnalyticsPage } from './features/analytics/AnalyticsPage'
import { AuditPage } from './features/audit/AuditPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { WorkspaceLayout } from './features/workspace/WorkspaceLayout'
import './App.css'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type SessionUser = {
  id: string
  email: string
  name: string
}

function App() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchSession = async () => {
    try {
      const response = await fetch(`${apiUrl}/auth/me`, { credentials: 'include' })
      if (!response.ok) {
        setUser(null)
        return
      }

      const payload = await response.json() as { user?: SessionUser }
      setUser(payload.user ?? null)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchSession()
  }, [])

  const onAuthenticated = async () => {
    setLoading(true)
    await fetchSession()
  }

  const onLogout = async () => {
    await fetch(`${apiUrl}/auth/logout`, { method: 'POST', credentials: 'include' })
    setUser(null)
  }

  if (loading) {
    return <main className="app-loading-shell"><div className="empty-state">Loading COLLABSPHERE…</div></main>
  }

  if (!user) {
    return <AuthPage onAuthenticated={onAuthenticated} />
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<WorkspaceLayout user={user} onLogout={onLogout} />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:boardId" element={<BoardPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/:documentId" element={<DocumentEditorPage currentUser={user} />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/huddle" element={<HuddlePage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/audit" element={<AuditPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
