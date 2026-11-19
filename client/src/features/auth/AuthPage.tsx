import { useState, type FormEvent } from 'react'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'
type AuthPageProps = { onAuthenticated: () => void }

export function AuthPage({ onAuthenticated }: AuthPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('Ari Chen')
  const [email, setEmail] = useState('ari@collabsphere.app')
  const [password, setPassword] = useState('password123')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError(''); setNotice('')
    try {
      const response = await fetch(`${apiUrl}/auth/${mode}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mode === 'register' ? { name, email, password } : { email, password }) })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Authentication failed')
      onAuthenticated()
    } catch (caughtError) { setError(caughtError instanceof Error ? caughtError.message : 'Authentication failed') } finally { setLoading(false) }
  }
  const handleForgotPassword = () => {
    if (!email) {
      setError('Please enter your email address to receive password reset instructions.')
      return
    }
    setError('')
    setNotice(`Password reset instructions sent to ${email}`)
  }
  const changeMode = () => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); setNotice('') }
  return <main className="auth-shell">
    <section className="auth-branding" aria-label="COLLABSPHERE overview">
      <div className="auth-grid" /><div className="auth-orb auth-orb-one" /><div className="auth-orb auth-orb-two" />
      <div className="auth-brand-content">
        <div className="auth-brand-lockup"><span className="auth-logo" aria-hidden="true"><i /><i /><i /></span><span>COLLABSPHERE</span></div>
        <p className="auth-badge"><span /> The future of collaboration</p>
        <h1>Enterprise collaboration,<br />simplified.</h1>
        <p className="auth-brand-copy">Bring your teams, projects, documents, and ideas together in one secure, intelligent workspace.</p>
        <div className="auth-features">
          <article><span className="feature-icon">⌘</span><div><h2>Unified Workspace</h2><p>Projects, documents, tasks, and communication in one place.</p></div></article>
          <article><span className="feature-icon">↗</span><div><h2>Real-time Collaboration</h2><p>Work together with instant updates and seamless synchronization.</p></div></article>
          <article><span className="feature-icon">◇</span><div><h2>Enterprise Security</h2><p>Permission-based access for modern teams.</p></div></article>
        </div>
      </div><div className="auth-network" aria-hidden="true"><span /><span /><span /><span /><i /><i /></div>
    </section>
    <section className="auth-form-area"><div className="auth-card">
      <div className="auth-mobile-brand"><span className="auth-logo"><i /><i /><i /></span> COLLABSPHERE</div>
      <div className="auth-header"><p className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Join COLLABSPHERE'}</p><h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2><p className="auth-subtitle">{mode === 'login' ? 'Sign in to access your workspace' : 'Start collaborating with your team today'}</p></div>
      <form className="auth-form" onSubmit={submit}>
        {mode === 'register' && <label><span>Full name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your full name" /></label>}
        <label><span>Email address</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@collabsphere.app" /></label>
        <label><span className="auth-password-label">Password {mode === 'login' && <button type="button" className="auth-forgot-btn" onClick={handleForgotPassword}>Forgot password?</button>}</span><span className="password-field"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /><button type="button" className="password-toggle" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</button></span></label>
        {notice && <div className="auth-notice" role="status">{notice}</div>}
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button type="submit" className="auth-submit" disabled={loading}>{loading ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'} <span aria-hidden="true">→</span></button>
      </form>
      <p className="auth-switch">{mode === 'login' ? "Don't have an account?" : 'Already have an account?'} <button type="button" onClick={changeMode}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
      <p className="auth-trust"><span aria-hidden="true">♢</span> Secure, private, and trusted by modern teams</p>
    </div></section>
  </main>
}
