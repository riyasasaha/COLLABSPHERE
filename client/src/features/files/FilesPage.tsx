import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { io, type Socket } from 'socket.io-client'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type FileVersionEntry = {
  id: string
  name: string
  mimeType: string
  size: number
  createdAt: string
  uploadedBy: { id: string; name: string }
}

type FileEntry = {
  id: string
  name: string
  mimeType: string
  size: number
  createdAt: string
  updatedAt: string
  owner: { id: string; name: string; email: string }
  versions?: FileVersionEntry[]
}

type PreviewState = {
  kind: 'image' | 'pdf' | 'text' | 'unsupported'
  url?: string
  text?: string
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

export function FilesPage() {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [currentUser, setCurrentUser] = useState<{ id: string; name: string } | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<Record<string, PreviewState>>({})
  const socketRef = useRef<Socket | null>(null)

  const loadFiles = async () => {
    setLoading(true)
    try {
      const response = await fetch(`${apiUrl}/api/files`, { credentials: 'include' })
      if (!response.ok) throw new Error('Unable to load files')
      const payload = await response.json() as { files?: FileEntry[] }
      setFiles(payload.files ?? [])
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Files unavailable')
    } finally {
      setLoading(false)
    }
  }

  const loadCurrentUser = async () => {
    try {
      const response = await fetch(`${apiUrl}/auth/me`, { credentials: 'include' })
      if (!response.ok) return
      const payload = await response.json() as { user?: { id: string; name: string } }
      setCurrentUser(payload.user ?? null)
    } catch {
      setCurrentUser(null)
    }
  }

  useEffect(() => {
    void loadCurrentUser()
    void loadFiles()
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
        // Ignore workspace resolution errors; file sync is optional until workspace loads.
      }
    }

    void loadWorkspace()
  }, [])

  useEffect(() => {
    if (!workspaceId) return

    const socket = io(apiUrl, { transports: ['websocket'], withCredentials: true })
    socketRef.current = socket
    socket.emit('workspace:join', { workspaceId })

    const handleFileCreated = (payload: { file?: FileEntry }) => {
      const incomingFile = payload.file
      if (!incomingFile) return
      setFiles((previous) => {
        if (previous.some((file) => file.id === incomingFile.id)) {
          return previous
        }
        return [incomingFile, ...previous]
      })
    }

    const handleFileDeleted = (payload: { fileId?: string }) => {
      const fileId = payload.fileId
      if (!fileId) return
      setFiles((previous) => previous.filter((file) => file.id !== fileId))
    }

    socket.on('file:created', handleFileCreated)
    socket.on('file:deleted', handleFileDeleted)

    return () => {
      socket.off('file:created', handleFileCreated)
      socket.off('file:deleted', handleFileDeleted)
      socket.emit('workspace:leave', { workspaceId })
      socket.disconnect()
      socketRef.current = null
    }
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    const objectUrls: string[] = []
    const nextPreviewData: Record<string, PreviewState> = {}

    const getPreviewKind = (mimeType: string) => {
      if (mimeType.startsWith('image/')) return 'image'
      if (mimeType === 'application/pdf') return 'pdf'
      if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml' || mimeType === 'text/csv') {
        return 'text'
      }
      return 'unsupported'
    }

    const controller = async () => {
      for (const file of files) {
        const previewKind = getPreviewKind(file.mimeType)

        if (previewKind === 'unsupported') {
          nextPreviewData[file.id] = { kind: 'unsupported' }
          continue
        }

        try {
          const response = await fetch(`${apiUrl}/api/files/${file.id}/download`, { credentials: 'include' })
          if (!response.ok) {
            nextPreviewData[file.id] = { kind: 'unsupported' }
            continue
          }

          const blob = await response.blob()

          if (previewKind === 'image' || previewKind === 'pdf') {
            const objectUrl = URL.createObjectURL(blob)
            objectUrls.push(objectUrl)
            nextPreviewData[file.id] = { kind: previewKind, url: objectUrl }
            continue
          }

          const text = await blob.text()
          nextPreviewData[file.id] = { kind: 'text', text: text.slice(0, 20000) }
        } catch {
          nextPreviewData[file.id] = { kind: 'unsupported' }
        }
      }

      if (!cancelled) {
        setPreviewData(nextPreviewData)
      }
    }

    void controller()

    return () => {
      cancelled = true
      objectUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [files])

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0]
    if (!selected) return

    setUploading(true)
    setError('')

    try {
      const formData = new FormData()
      formData.append('file', selected)
      formData.append('name', selected.name)

      const response = await fetch(`${apiUrl}/api/files`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })

      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to upload file')

      event.target.value = ''
      await loadFiles()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to upload file')
    } finally {
      setUploading(false)
    }
  }

  const handleDownload = async (file: FileEntry) => {
    try {
      const response = await fetch(`${apiUrl}/api/files/${file.id}/download`, { credentials: 'include' })
      if (!response.ok) throw new Error('Unable to download file')
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = file.name
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 500)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to download file')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const response = await fetch(`${apiUrl}/api/files/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? 'Unable to delete file')
      }
      setFiles((prev) => prev.filter((file) => file.id !== id))
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to delete file')
    }
  }

  return (
    <div className="page-stack">
      <div className="page-header-row">
        <div>
          <p className="eyebrow">FILE MANAGEMENT</p>
          <h2>Shared workspace files</h2>
        </div>
      </div>

      <div className="file-form">
        <label className="file-upload-input">
          <span>Upload file</span>
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.doc,.docx" onChange={handleUpload} disabled={uploading} />
        </label>
        <div className="file-upload-status">{uploading ? 'Uploading…' : 'PDF, images, and text documents supported.'}</div>
      </div>

      {error && <div className="error-state">{error}</div>}

      {loading ? (
        <div className="page-panel"><div className="empty-state">Loading files…</div></div>
      ) : files.length === 0 ? (
        <div className="page-panel"><div className="empty-state">No files uploaded yet.</div></div>
      ) : (
        <div className="file-grid">
          {files.map((file) => {
            const canDelete = currentUser ? file.owner.id === currentUser.id : false
            const preview = previewData[file.id]
            const isImage = file.mimeType.startsWith('image/')
            const isPdf = file.mimeType === 'application/pdf'
            const isText = file.mimeType.startsWith('text/') || file.mimeType === 'application/json' || file.mimeType === 'application/xml' || file.mimeType === 'text/csv'

            return (
              <article key={file.id} className="file-card">
                <div className="file-card-header">
                  <span className="file-icon">{isPdf ? '📄' : isImage ? '🖼️' : isText ? '📝' : '📁'}</span>
                  <strong>{file.name}</strong>
                </div>

                <div className="file-preview">
                  {preview?.kind === 'image' && preview.url ? (
                    <img src={preview.url} alt={file.name} className="file-preview-image" />
                  ) : preview?.kind === 'pdf' && preview.url ? (
                    <iframe title={file.name} src={preview.url} className="file-preview-pdf" />
                  ) : preview?.kind === 'text' ? (
                    <pre className="file-text-preview">{preview.text || 'No text available'}</pre>
                  ) : (
                    <div className="file-preview-placeholder">No inline preview available</div>
                  )}
                </div>

                <div className="file-meta-grid">
                  <span><strong>Size:</strong> {formatFileSize(file.size)}</span>
                  <span><strong>Uploaded:</strong> {new Date(file.createdAt).toLocaleDateString()}</span>
                  <span><strong>By:</strong> {file.owner.name}</span>
                </div>

                <div className="file-actions">
                  <button type="button" className="secondary-button small" onClick={() => { void handleDownload(file) }}>Download</button>
                  {canDelete && (
                    <button type="button" className="secondary-button small danger-button" onClick={() => { void handleDelete(file.id) }}>Delete</button>
                  )}
                </div>

                {file.versions && file.versions.length > 0 && (
                  <div className="file-version-list">
                    <h4>Version history</h4>
                    {file.versions.map((version) => (
                      <div key={version.id} className="file-version-item">
                        <span>{version.name}</span>
                        <span>{version.uploadedBy.name}</span>
                        <span>{new Date(version.createdAt).toLocaleDateString()}</span>
                        <span>{formatFileSize(version.size)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
