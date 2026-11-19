import { randomBytes, createHash } from 'node:crypto'
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { prisma } from '../prisma.js'
import { clearAuthCookie, oauthCookieName, readCookie, setAuthCookie } from './cookies.js'
import { requireAuth } from './middleware.js'
import type { AuthenticatedRequest } from './types.js'

const router = Router()
const jwtSecret = process.env.JWT_SECRET ?? 'development-only-change-me'
const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:5173'
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:4000/auth/google/callback'

async function ensureWorkspaceForUser(user: { id: string; email: string; name: string }) {
  const existingMembership = await prisma.workspaceMember.findFirst({
    where: { userId: user.id },
    include: { workspace: true },
    orderBy: { joinedAt: 'desc' },
  })

  if (existingMembership) return existingMembership.workspace

  const workspace = await prisma.workspace.create({
    data: {
      name: `${user.name.split(' ')[0] || 'Workspace'}'s Workspace`,
      slug: `workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ownerId: user.id,
      members: { create: { userId: user.id, role: 'SUPER_ADMIN' } },
    },
  })

  await prisma.auditLog.create({
    data: {
      workspaceId: workspace.id,
      actorId: user.id,
      action: 'LOGIN',
      entityType: 'user',
      entityId: user.id,
      metadata: { email: user.email },
    },
  })

  return workspace
}

function issueSession(user: { id: string; email: string; name: string }, response: Parameters<typeof setAuthCookie>[0]) {
  const token = jwt.sign({ sub: user.id, email: user.email, name: user.name }, jwtSecret, { expiresIn: '7d' })
  setAuthCookie(response, token)
}

router.post('/register', async (request, response) => {
  const { email, name, password } = request.body as Record<string, string>
  if (!email || !name || !password || password.length < 8) {
    return response.status(400).json({ error: 'Name, email, and an 8-character password are required' })
  }
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
  if (existing) return response.status(409).json({ error: 'An account with that email already exists' })
  const user = await prisma.user.create({
    data: { email: email.toLowerCase(), name, passwordHash: await bcrypt.hash(password, 12) },
    select: { id: true, email: true, name: true },
  })
  issueSession(user, response)
  return response.status(201).json({ user })
})

router.post('/login', async (request, response) => {
  const { email, password } = request.body as Record<string, string>
  const user = await prisma.user.findUnique({ where: { email: email?.toLowerCase() } })
  if (!user?.passwordHash || !(await bcrypt.compare(password ?? '', user.passwordHash))) {
    return response.status(401).json({ error: 'Invalid email or password' })
  }

  issueSession(user, response)

  const workspace = await ensureWorkspaceForUser(user)
  await prisma.auditLog.create({
    data: {
      workspaceId: workspace.id,
      actorId: user.id,
      action: 'LOGIN',
      entityType: 'user',
      entityId: user.id,
      metadata: { email: user.email },
    },
  })

  return response.json({ user: { id: user.id, email: user.email, name: user.name } })
})

router.post('/logout', async (request, response) => {
  const token = readCookie(request, 'auth')
  if (token) {
    try {
      const claims = jwt.verify(token, jwtSecret) as { sub: string; email: string; name: string }
      const user = await prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true, email: true, name: true } })
      if (user) {
        const workspace = await ensureWorkspaceForUser(user)
        await prisma.auditLog.create({
          data: {
            workspaceId: workspace.id,
            actorId: user.id,
            action: 'LOGOUT',
            entityType: 'user',
            entityId: user.id,
            metadata: { email: user.email },
          },
        })
      }
    } catch {
      // ignore invalid logout token and still clear the cookie
    }
  }

  clearAuthCookie(response)
  return response.status(204).end()
})

router.get('/me', requireAuth, (request: AuthenticatedRequest, response) => response.json({ user: request.user }))

router.get('/google', (_request, response) => {
  if (!process.env.GOOGLE_CLIENT_ID) return response.status(503).json({ error: 'Google OAuth is not configured' })
  const state = randomBytes(24).toString('hex')
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  response.cookie(oauthCookieName, JSON.stringify({ state, verifier }), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/auth/google',
  })
  const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: googleRedirectUri, response_type: 'code', scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'select_account' })
  return response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

router.get('/google/callback', async (request, response) => {
  const saved = readCookie(request, oauthCookieName)
  const { code, state } = request.query as { code?: string; state?: string }
  if (!saved || !code || !state) return response.redirect(`${clientUrl}/oauth/callback?error=invalid_oauth_state`)
  let oauth: { state: string; verifier: string }
  try { oauth = JSON.parse(saved) } catch { return response.redirect(`${clientUrl}/oauth/callback?error=invalid_oauth_state`) }
  if (oauth.state !== state) return response.redirect(`${clientUrl}/oauth/callback?error=invalid_oauth_state`)

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '', redirect_uri: googleRedirectUri, grant_type: 'authorization_code', code_verifier: oauth.verifier }) })
  if (!tokenResponse.ok) return response.redirect(`${clientUrl}/oauth/callback?error=oauth_exchange_failed`)
  const tokens = await tokenResponse.json() as { access_token?: string }
  const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` } })
  if (!profileResponse.ok) return response.redirect(`${clientUrl}/oauth/callback?error=profile_fetch_failed`)
  const profile = await profileResponse.json() as { sub: string; email: string; name: string; picture?: string }
  const existingGoogleUser = await prisma.user.findUnique({ where: { googleId: profile.sub } })
  const user = existingGoogleUser
    ? await prisma.user.update({ where: { id: existingGoogleUser.id }, data: { email: profile.email, name: profile.name, avatarUrl: profile.picture }, select: { id: true, email: true, name: true } })
    : await prisma.user.upsert({ where: { email: profile.email }, update: { googleId: profile.sub, name: profile.name, avatarUrl: profile.picture }, create: { googleId: profile.sub, email: profile.email, name: profile.name, avatarUrl: profile.picture }, select: { id: true, email: true, name: true } })
  issueSession(user, response)
  return response.redirect(`${clientUrl}/oauth/callback?success=true`)
})

export default router
