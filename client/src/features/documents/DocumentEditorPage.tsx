import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { io, type Socket } from 'socket.io-client'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type UserInfo = {
  id: string
  name: string
  email: string
  avatarUrl?: string | null
}

type Collaborator = {
  socketId: string
  userId: string
  name: string
  color: string
  cursor?: { from: number; to: number }
}

type DocumentComment = {
  id: string
  content: string
  createdAt: string
  author: {
    id: string
    name: string
    avatarUrl?: string | null
  }
}

type DocumentVersion = {
  id: string
  version: number
  content: string
  createdAt: string
  author: {
    id: string
    name: string
  }
}

type DocumentData = {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  author: {
    id: string
    name: string
  }
  versions: DocumentVersion[]
  comments: DocumentComment[]
}

type DocumentEditorProps = {
  currentUser?: UserInfo
}

export function DocumentEditorPage({ currentUser }: DocumentEditorProps) {
  const { documentId } = useParams()
  const [docData, setDocData] = useState<DocumentData | null>(null)
  const [title, setTitle] = useState('')
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved')
  const [collaborators, setCollaborators] = useState<Collaborator[]>([])
  const [typingUser, setTypingUser] = useState<string | null>(null)
  const [comments, setComments] = useState<DocumentComment[]>([])
  const [newComment, setNewComment] = useState('')
  const [showComments, setShowComments] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [workspaceMembers, setWorkspaceMembers] = useState<UserInfo[]>([])
  const [showMentionPicker, setShowMentionPicker] = useState(false)
  const [previewVersion, setPreviewVersion] = useState<DocumentVersion | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const socketRef = useRef<Socket | null>(null)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isLocalUpdateRef = useRef(false)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: 'Start writing your document... Use the toolbar above or type "/" for options.',
      }),
    ],
    content: '',
    onUpdate: ({ editor: currentEditor }) => {
      if (isLocalUpdateRef.current) return

      const html = currentEditor.getHTML()
      setSaveStatus('saving')

      // Emit real-time content update via Socket.IO
      if (socketRef.current && documentId) {
        socketRef.current.emit('doc:update', {
          documentId,
          content: html,
        })

        socketRef.current.emit('doc:typing', {
          documentId,
          user: { id: currentUser?.id || 'local', name: currentUser?.name || 'Ari Chen' },
          isTyping: true,
        })
      }

      // Debounce persistent save to PostgreSQL
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = setTimeout(() => {
        void saveDocumentContent(html)
      }, 1200)
    },
    onSelectionUpdate: ({ editor: currentEditor }) => {
      if (!socketRef.current || !documentId) return
      const { from, to } = currentEditor.state.selection
      socketRef.current.emit('doc:cursor', {
        documentId,
        cursor: { from, to },
        user: { id: currentUser?.id || 'local', name: currentUser?.name || 'Ari Chen' },
      })
    },
  })

  const saveDocumentContent = async (content: string, createVersion = false) => {
    if (!documentId) return
    try {
      const response = await fetch(`${apiUrl}/api/documents/${documentId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content,
          createVersionSnapshot: createVersion,
        }),
      })

      if (!response.ok) throw new Error('Save failed')
      const payload = await response.json() as { document: DocumentData }
      setDocData(payload.document)
      setSaveStatus('saved')
    } catch {
      setSaveStatus('error')
    }
  }

  const loadDocument = useCallback(async () => {
    if (!documentId) return
    try {
      const response = await fetch(`${apiUrl}/api/documents/${documentId}`, { credentials: 'include' })
      if (!response.ok) throw new Error('Document not found')
      const payload = await response.json() as { document: DocumentData }
      setDocData(payload.document)
      setTitle(payload.document.title)
      setComments(payload.document.comments || [])

      if (editor && !editor.isDestroyed) {
        isLocalUpdateRef.current = true
        editor.commands.setContent(payload.document.content || '')
        isLocalUpdateRef.current = false
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to load document')
    } finally {
      setLoading(false)
    }
  }, [documentId, editor])

  useEffect(() => {
    if (editor) {
      void loadDocument()
    }
  }, [editor, loadDocument])

  // Fetch workspace members for @mentions
  useEffect(() => {
    async function fetchMembers() {
      try {
        const response = await fetch(`${apiUrl}/api/workspace/members`, { credentials: 'include' })
        if (response.ok) {
          const payload = await response.json() as { members?: UserInfo[] }
          setWorkspaceMembers(payload.members ?? [])
        }
      } catch {
        // Fallback members
        setWorkspaceMembers([{ id: '1', name: 'Ari Chen', email: 'ari@collabsphere.app' }])
      }
    }
    void fetchMembers()
  }, [])

  // Socket.IO Room & Realtime listeners
  useEffect(() => {
    if (!documentId) return
    const socket = io(apiUrl, { transports: ['websocket'], withCredentials: true })
    socketRef.current = socket

    const localUser = {
      id: currentUser?.id || `user-${Date.now()}`,
      name: currentUser?.name || 'Ari Chen',
    }

    socket.emit('doc:join', { documentId, user: localUser })

    socket.on('doc:presence_update', (data: { users: Collaborator[] }) => {
      setCollaborators(data.users || [])
    })

    socket.on('doc:update', (data: { content?: string; senderId?: string }) => {
      if (data.senderId !== socket.id && data.content !== undefined && editor) {
        isLocalUpdateRef.current = true
        editor.commands.setContent(data.content, false)
        isLocalUpdateRef.current = false
        setSaveStatus('saved')
      }
    })

    socket.on('doc:typing', (data: { user: { name: string }; isTyping: boolean }) => {
      if (data.isTyping) {
        setTypingUser(data.user.name)
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
        typingTimeoutRef.current = setTimeout(() => {
          setTypingUser(null)
        }, 2000)
      }
    })

    socket.on('doc:meta_updated', (data: { title?: string }) => {
      if (data.title) setTitle(data.title)
    })

    socket.on('doc:restored', (data: { content?: string }) => {
      if (data.content !== undefined && editor) {
        isLocalUpdateRef.current = true
        editor.commands.setContent(data.content, false)
        isLocalUpdateRef.current = false
        void loadDocument()
      }
    })

    socket.on('doc:comment_added', (data: { comment: DocumentComment }) => {
      setComments((prev) => [...prev, data.comment])
    })

    socket.on('doc:comment_deleted', (data: { commentId: string }) => {
      setComments((prev) => prev.filter((c) => c.id !== data.commentId))
    })

    return () => {
      socket.emit('doc:leave', { documentId })
      socket.disconnect()
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    }
  }, [documentId, editor, currentUser, loadDocument])

  const handleTitleBlur = async () => {
    setIsEditingTitle(false)
    if (!documentId || !title.trim()) return

    try {
      await fetch(`${apiUrl}/api/documents/${documentId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      })
    } catch {
      // Ignored
    }
  }

  const handleCreateVersionSnapshot = async () => {
    if (!documentId || !editor) return
    try {
      const response = await fetch(`${apiUrl}/api/documents/${documentId}/versions`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Could not create snapshot')
      await loadDocument()
      setShowVersions(true)
    } catch (caughtError) {
      alert(caughtError instanceof Error ? caughtError.message : 'Snapshot creation failed')
    }
  }

  const handleRestoreVersion = async (versionId: string) => {
    if (!documentId) return
    if (!confirm('Restore document to this historical snapshot? This will save a new version without losing history.')) return

    try {
      const response = await fetch(`${apiUrl}/api/documents/${documentId}/restore/${versionId}`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Could not restore version')
      const payload = await response.json() as { document: DocumentData }
      setDocData(payload.document)
      if (editor) {
        isLocalUpdateRef.current = true
        editor.commands.setContent(payload.document.content)
        isLocalUpdateRef.current = false
      }
      setPreviewVersion(null)
      setShowVersions(false)
    } catch (caughtError) {
      alert(caughtError instanceof Error ? caughtError.message : 'Restoration failed')
    }
  }

  const handleAddComment = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!documentId || !newComment.trim()) return

    try {
      const response = await fetch(`${apiUrl}/api/documents/${documentId}/comments`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: newComment }),
      })
      if (!response.ok) throw new Error('Could not post comment')
      setNewComment('')
    } catch (caughtError) {
      alert(caughtError instanceof Error ? caughtError.message : 'Comment posting failed')
    }
  }

  const handleDeleteComment = async (commentId: string) => {
    if (!documentId) return
    try {
      const response = await fetch(`${apiUrl}/api/documents/${documentId}/comments/${commentId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Could not delete comment')
    } catch (caughtError) {
      alert(caughtError instanceof Error ? caughtError.message : 'Comment deletion failed')
    }
  }

  const insertMention = (member: UserInfo) => {
    if (!editor) return
    editor.chain().focus().insertContent(`@${member.name} `).run()
    setShowMentionPicker(false)
  }

  if (loading) {
    return (
      <div className="page-panel">
        <div className="empty-state">Loading collaborative document editor…</div>
      </div>
    )
  }

  if (error || !docData) {
    return (
      <div className="page-panel">
        <div className="error-state">{error || 'Document not found'}</div>
        <Link to="/documents" className="secondary-button" style={{ display: 'inline-block', marginTop: '14px' }}>
          &larr; Back to Documents
        </Link>
      </div>
    )
  }

  return (
    <div className="doc-editor-workspace">
      {/* Top Header Bar */}
      <header className="doc-editor-header">
        <div className="doc-header-left">
          <Link to="/documents" className="doc-back-link" title="Back to documents list">
            &larr; Documents
          </Link>
          <span className="doc-header-separator">/</span>

          {isEditingTitle ? (
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => { void handleTitleBlur() }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleTitleBlur()
              }}
              autoFocus
              className="doc-title-input"
            />
          ) : (
            <h2
              className="doc-title-display"
              onClick={() => setIsEditingTitle(true)}
              title="Click to rename document"
            >
              {title || 'Untitled document'} <span className="doc-edit-icon">✎</span>
            </h2>
          )}

          <div className={`doc-save-badge ${saveStatus}`}>
            {saveStatus === 'saving' && <span className="saving-spinner" />}
            {saveStatus === 'saved' && '● Saved'}
            {saveStatus === 'saving' && 'Saving…'}
            {saveStatus === 'error' && 'Offline / Unsaved'}
          </div>
        </div>

        <div className="doc-header-right">
          {/* Active Collaborators */}
          <div className="doc-presence-avatars" title="Users currently viewing/editing">
            <span className="presence-label">Viewing:</span>
            {collaborators.map((c) => (
              <div
                key={c.socketId}
                className="collaborator-avatar"
                style={{ backgroundColor: c.color, borderColor: c.color }}
                title={`${c.name} is active`}
              >
                {c.name.charAt(0).toUpperCase()}
              </div>
            ))}
          </div>

          <button
            type="button"
            className="secondary-button doc-header-btn"
            onClick={() => { void handleCreateVersionSnapshot() }}
            title="Save named snapshot"
          >
            💾 Save Snapshot
          </button>

          <button
            type="button"
            className={`secondary-button doc-header-btn ${showVersions ? 'active' : ''}`}
            onClick={() => {
              setShowVersions(!showVersions)
              setShowComments(false)
            }}
          >
            🕒 History ({docData.versions?.length ?? 1})
          </button>

          <button
            type="button"
            className={`secondary-button doc-header-btn ${showComments ? 'active' : ''}`}
            onClick={() => {
              setShowComments(!showComments)
              setShowVersions(false)
            }}
          >
            💬 Comments ({comments.length})
          </button>
        </div>
      </header>

      {/* Rich Text Toolbar */}
      {editor && (
        <div className="doc-toolbar">
          <div className="toolbar-group">
            <button
              type="button"
              onClick={() => editor.chain().focus().setParagraph().run()}
              className={`toolbar-btn ${editor.isActive('paragraph') ? 'active' : ''}`}
            >
              Text
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
              className={`toolbar-btn ${editor.isActive('heading', { level: 1 }) ? 'active' : ''}`}
            >
              H1
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              className={`toolbar-btn ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`}
            >
              H2
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
              className={`toolbar-btn ${editor.isActive('heading', { level: 3 }) ? 'active' : ''}`}
            >
              H3
            </button>
          </div>

          <div className="toolbar-divider" />

          <div className="toolbar-group">
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleBold().run()}
              className={`toolbar-btn ${editor.isActive('bold') ? 'active' : ''}`}
              title="Bold (Ctrl+B)"
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleItalic().run()}
              className={`toolbar-btn ${editor.isActive('italic') ? 'active' : ''}`}
              title="Italic (Ctrl+I)"
            >
              <em>I</em>
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleStrike().run()}
              className={`toolbar-btn ${editor.isActive('strike') ? 'active' : ''}`}
              title="Strikethrough"
            >
              <s>S</s>
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleCode().run()}
              className={`toolbar-btn ${editor.isActive('code') ? 'active' : ''}`}
              title="Inline Code"
            >
              &lt;/&gt;
            </button>
          </div>

          <div className="toolbar-divider" />

          <div className="toolbar-group">
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              className={`toolbar-btn ${editor.isActive('bulletList') ? 'active' : ''}`}
              title="Bullet List"
            >
              • List
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              className={`toolbar-btn ${editor.isActive('orderedList') ? 'active' : ''}`}
              title="Numbered List"
            >
              1. List
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
              className={`toolbar-btn ${editor.isActive('blockquote') ? 'active' : ''}`}
              title="Blockquote"
            >
              &ldquo; Quote
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
              className={`toolbar-btn ${editor.isActive('codeBlock') ? 'active' : ''}`}
              title="Code Block"
            >
              Code Block
            </button>
          </div>

          <div className="toolbar-divider" />

          <div className="toolbar-group">
            <button
              type="button"
              onClick={() => setShowMentionPicker(!showMentionPicker)}
              className="toolbar-btn mention-btn"
              title="Insert Team @Mention"
            >
              @ Mention
            </button>
          </div>

          <div className="toolbar-divider" />

          <div className="toolbar-group toolbar-undo-group">
            <button
              type="button"
              onClick={() => editor.chain().focus().undo().run()}
              disabled={!editor.can().undo()}
              className="toolbar-btn"
              title="Undo (Ctrl+Z)"
            >
              ↺
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().redo().run()}
              disabled={!editor.can().redo()}
              className="toolbar-btn"
              title="Redo (Ctrl+Y)"
            >
              ↻
            </button>
          </div>
        </div>
      )}

      {/* Mention Picker Popup */}
      {showMentionPicker && (
        <div className="mention-picker-dropdown">
          <p className="mention-picker-header">Select Team Member to @Mention</p>
          <div className="mention-picker-list">
            {workspaceMembers.map((m) => (
              <button
                key={m.id}
                type="button"
                className="mention-picker-item"
                onClick={() => insertMention(m)}
              >
                <span className="mention-avatar">{m.name.charAt(0)}</span>
                <div>
                  <strong>{m.name}</strong>
                  <small>{m.email}</small>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main Document Body Layout */}
      <div className="doc-editor-main">
        {/* Paper Canvas */}
        <div className="doc-canvas-container">
          <div className="doc-paper">
            <EditorContent editor={editor} className="doc-tiptap-content" />
          </div>

          {/* Typing Presence Strip */}
          {typingUser && (
            <div className="doc-typing-indicator">
              <span className="typing-pulse" />
              <strong>{typingUser}</strong> is editing…
            </div>
          )}
        </div>

        {/* Side Panel: Comments */}
        {showComments && (
          <aside className="doc-side-panel">
            <div className="panel-header">
              <h3>Document Discussion</h3>
              <button type="button" className="drawer-close" onClick={() => setShowComments(false)}>
                &times;
              </button>
            </div>

            <div className="comments-list">
              {comments.length === 0 ? (
                <div className="empty-state compact">No comments yet. Start a discussion below!</div>
              ) : (
                comments.map((comment) => (
                  <article key={comment.id} className="comment-card">
                    <div className="comment-header">
                      <div className="comment-author">
                        <span className="comment-avatar">
                          {comment.author?.name ? comment.author.name.charAt(0).toUpperCase() : 'U'}
                        </span>
                        <strong>{comment.author?.name || 'Team member'}</strong>
                      </div>
                      <div className="comment-header-right">
                        <small>{new Date(comment.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
                        <button
                          type="button"
                          className="comment-del-btn"
                          title="Delete comment"
                          onClick={() => { void handleDeleteComment(comment.id) }}
                        >
                          &times;
                        </button>
                      </div>
                    </div>
                    <p className="comment-body">{comment.content}</p>
                  </article>
                ))
              )}
            </div>

            <form className="comment-composer" onSubmit={handleAddComment}>
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Write a comment or @mention a team member..."
                rows={3}
              />
              <div className="comment-composer-footer">
                <button
                  type="button"
                  className="secondary-button small"
                  onClick={() => {
                    const first = workspaceMembers[0]
                    if (first) setNewComment((prev) => `${prev} @${first.name} `)
                  }}
                >
                  + @tag
                </button>
                <button type="submit" className="primary-button small" disabled={!newComment.trim()}>
                  Post Comment
                </button>
              </div>
            </form>
          </aside>
        )}

        {/* Side Panel: Version History */}
        {showVersions && (
          <aside className="doc-side-panel">
            <div className="panel-header">
              <h3>Version History</h3>
              <button type="button" className="drawer-close" onClick={() => setShowVersions(false)}>
                &times;
              </button>
            </div>

            <div className="version-list">
              {docData.versions?.map((ver, idx) => (
                <article
                  key={ver.id}
                  className={`version-card ${previewVersion?.id === ver.id ? 'active' : ''}`}
                >
                  <div className="version-card-header">
                    <span className="version-tag">
                      v{ver.version} {idx === 0 ? '(Current)' : ''}
                    </span>
                    <small>{new Date(ver.createdAt).toLocaleString()}</small>
                  </div>
                  <p className="version-author">Saved by {ver.author?.name || 'Team member'}</p>

                  <div className="version-actions">
                    {idx !== 0 && (
                      <button
                        type="button"
                        className="primary-button small version-restore-btn"
                        onClick={() => { void handleRestoreVersion(ver.id) }}
                      >
                        Restore this version
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
