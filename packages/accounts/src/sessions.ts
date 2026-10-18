import { base64UrlEncode, randomBytes, sha256, sha256Hex, utf8 } from './encoding.ts'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const BREAK_GLASS_SESSION_TTL_MS = 60 * 60 * 1000

export const SESSION_TOUCH_RESOLUTION_MS = 60 * 1000

export const SESSION_METHODS = ['oidc', 'passkey', 'break-glass'] as const

export type SessionMethod = (typeof SESSION_METHODS)[number]

export const SESSION_PREFIX = 'gfs_'

const SESSION_PATTERN = /^gfs_[A-Za-z0-9_-]{43}$/

export const CSRF_HEADER = 'X-CSRF-Token'

export const CSRF_FIELD = 'csrf'

export const generateSessionToken = (): string => `${SESSION_PREFIX}${base64UrlEncode(randomBytes(32))}`

export const isSessionToken = (value: string): boolean => SESSION_PATTERN.test(value)

export const hashSessionToken = (token: string): Promise<string> => sha256Hex(token)

export const csrfTokenFor = async (sessionToken: string): Promise<string> => base64UrlEncode(await sha256(`git-forge csrf\n${sessionToken}`))

export const constantTimeEqual = async (a: string, b: string): Promise<boolean> => {
  const [x, y] = await Promise.all([sha256(utf8(a)), sha256(utf8(b))])
  let difference = 0
  for (let i = 0; i < x.length; i++) difference |= x[i]! ^ y[i]!
  return difference === 0
}

export const csrfMatches = async (sessionToken: string, presented: string | null | undefined): Promise<boolean> =>
  typeof presented === 'string' && presented !== '' && constantTimeEqual(presented, await csrfTokenFor(sessionToken))

export type CookieNames = {
  readonly session: string
  readonly oidc: string
}

export const cookieNames = (secure: boolean): CookieNames =>
  secure ? { session: '__Host-gf_session', oidc: '__Host-gf_oidc' } : { session: 'gf_session', oidc: 'gf_oidc' }

export type CookieOptions = {
  readonly secure: boolean
  readonly maxAgeSeconds: number
  readonly path?: string
}

export const formatCookie = (name: string, value: string, options: CookieOptions): string =>
  [
    `${name}=${value}`,
    `Path=${options.path ?? '/'}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')

export const clearCookie = (name: string, secure: boolean): string => formatCookie(name, '', { secure, maxAgeSeconds: 0 })

export const parseCookies = (header: string | null): Map<string, string> => {
  const cookies = new Map<string, string>()
  if (!header) return cookies
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    if (!cookies.has(name)) cookies.set(name, part.slice(index + 1).trim())
  }
  return cookies
}

export const safeReturnTo = (value: string | null | undefined, fallback = '/'): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return fallback
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback
  if (/[\u0000-\u001f\\]/.test(value)) return fallback
  return value
}

export const isUnsafeMethod = (method: string): boolean => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())

export const sameOrigin = (request: Request, origin: string): boolean => {
  const presented = request.headers.get('Origin')
  if (presented !== null) return presented === origin
  const fetchSite = request.headers.get('Sec-Fetch-Site')
  return fetchSite === null || fetchSite === 'same-origin' || fetchSite === 'none'
}
