import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type WorkspaceMember = {
  id: string
  userId: string
  name: string
  email: string
  role: 'SUPER_ADMIN' | 'WORKSPACE_ADMIN' | 'MEMBER' | 'GUEST'
  avatarUrl?: string | null
}

export function SettingsPage() {
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [currentRole, setCurrentRole] = useState('MEMBER')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [memberEmail, setMemberEmail] = useState('')
  const [memberRole, setMemberRole] = useState<'MEMBER' | 'GUEST'>('MEMBER')
  const [addMemberMessage, setAddMemberMessage] = useState('')
  const [addingMember, setAddingMember] = useState(false)

  const loadPermissions = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/workspace/permissions`, { credentials: 'include' })
      if (!response.ok) throw new Error('Unable to load workspace permissions')
      const payload = await response.json() as { currentUserRole?: string; members?: WorkspaceMember[] }
      setCurrentRole(payload.currentUserRole ?? 'MEMBER')
      setMembers(payload.members ?? [])
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Permissions unavailable')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadPermissions() }, [])

  const addMember = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAddingMember(true)
    setAddMemberMessage('')
    setError('')
    try {
      const response = await fetch(`${apiUrl}/api/workspace/members`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: memberEmail, role: memberRole }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to add workspace member')
      setMemberEmail('')
      setAddMemberMessage('Workspace member added.')
      await loadPermissions()
    } catch (caughtError) {
      setAddMemberMessage(caughtError instanceof Error ? caughtError.message : 'Unable to add workspace member')
    } finally {
      setAddingMember(false)
    }
  }

  const updateRole = async (memberId: string, role: WorkspaceMember['role']) => {
    try {
      const response = await fetch(`${apiUrl}/api/workspace/members/${memberId}/role`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? 'Unable to update member role')
      }
      setMembers((prev) => prev.map((member) => member.id === memberId ? { ...member, role } : member))
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to update role')
    }
  }

  if (loading) return <div className="page-panel"><div className="empty-state">Loading permissions…</div></div>

  return (
    <div className="page-stack">
      <div className="page-header-row">
        <div>
          <p className="eyebrow">WORKSPACE SETTINGS</p>
          <h2>RBAC & permissions</h2>
        </div>
      </div>

      <div className="panel-card settings-summary">
        <strong>Current role</strong>
        <span>{currentRole}</span>
      </div>

      {currentRole === 'SUPER_ADMIN' || currentRole === 'WORKSPACE_ADMIN' ? (
        <div className="page-header-row">
          <div />
          <Link to="/settings/audit" className="primary-button small">View audit logs</Link>
        </div>
      ) : null}

      {error && <div className="error-state">{error}</div>}

      {currentRole === 'SUPER_ADMIN' || currentRole === 'WORKSPACE_ADMIN' ? (
        <form className="member-add-form" onSubmit={(event) => { void addMember(event) }}>
          <div>
            <h3>Add workspace member</h3>
            <p>Invite a registered user to this workspace.</p>
          </div>
          <label>
            Email
            <input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="rahul@example.com" required />
          </label>
          <label>
            Role
            <select value={memberRole} onChange={(event) => setMemberRole(event.target.value as 'MEMBER' | 'GUEST')}>
              <option value="MEMBER">MEMBER</option>
              <option value="GUEST">GUEST</option>
            </select>
          </label>
          <button type="submit" className="primary-button" disabled={addingMember}>
            {addingMember ? 'Adding member…' : 'Add member'}
          </button>
          {addMemberMessage && <small className="member-add-message">{addMemberMessage}</small>}
        </form>
      ) : null}

      <div className="member-list">
        {members.map((member) => (
          <div key={member.id} className="member-card">
            <div>
              <strong>{member.name}</strong>
              <small>{member.email}</small>
            </div>
            <div className="member-role-controls">
              {(currentRole === 'SUPER_ADMIN' || currentRole === 'WORKSPACE_ADMIN') && member.userId !== member.id ? (
                <select value={member.role} onChange={(event) => { void updateRole(member.id, event.target.value as WorkspaceMember['role']) }}>
                  <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                  <option value="WORKSPACE_ADMIN">WORKSPACE_ADMIN</option>
                  <option value="MEMBER">MEMBER</option>
                  <option value="GUEST">GUEST</option>
                </select>
              ) : (
                <span className="role-pill">{member.role}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
