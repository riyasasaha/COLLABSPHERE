import type { NextFunction, Response } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../prisma.js'
import { authCookieName, readCookie } from './cookies.js'
import type { AuthenticatedRequest } from './types.js'
import type { WorkspaceRole } from '@prisma/client'

const jwtSecret = process.env.JWT_SECRET ?? 'development-only-change-me'

type SessionClaims = { sub: string; email: string; name: string }

export function requireAuth(request: AuthenticatedRequest, response: Response, next: NextFunction) {
  const token = readCookie(request, authCookieName)
  if (!token) return response.status(401).json({ error: 'Authentication required' })

  try {
    const claims = jwt.verify(token, jwtSecret) as SessionClaims
    request.user = { id: claims.sub, email: claims.email, name: claims.name }
    return next()
  } catch {
    return response.status(401).json({ error: 'Invalid or expired session' })
  }
}

export function requireRole(allowedRoles: WorkspaceRole[]) {
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction) => {
    if (!request.user) return response.status(401).json({ error: 'Authentication required' })
    const workspaceId = Array.isArray(request.params.workspaceId) ? request.params.workspaceId[0] : request.params.workspaceId
    if (!workspaceId) return response.status(400).json({ error: 'workspaceId is required' })

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: request.user.id } },
      select: { role: true },
    })
    if (!membership || !allowedRoles.includes(membership.role)) {
      return response.status(403).json({ error: 'Insufficient workspace permissions' })
    }
    request.workspaceRole = membership.role
    return next()
  }
}
