import type { Response } from 'express'

export const authCookieName = 'collabsphere_session'
export const oauthCookieName = 'collabsphere_oauth'

export function readCookie(request: { headers: { cookie?: string } }, name: string) {
  const cookies = request.headers.cookie?.split(';').map((part) => part.trim()) ?? []
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined
}

export function setAuthCookie(response: Response, token: string) {
  response.cookie(authCookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7,
    path: '/',
  })
}

export function clearAuthCookie(response: Response) {
  response.clearCookie(authCookieName, { httpOnly: true, sameSite: 'lax', path: '/' })
}
