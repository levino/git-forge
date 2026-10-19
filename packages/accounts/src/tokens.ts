import { base64UrlEncode, randomBytes, sha256Hex } from './encoding.ts'
import type { Access } from './roles.ts'

export const TOKEN_SCOPES = ['repo:read', 'repo:write', 'repo:admin'] as const

export type TokenScope = (typeof TOKEN_SCOPES)[number]

export const SCIM_SCOPE = 'scim'

export type TokenKind = 'personal' | 'app'

const PREFIXES: Record<TokenKind, string> = { personal: 'gfp_', app: 'gfa_' }

const TOKEN_PATTERN = /^(gfp|gfa)_[A-Za-z0-9_-]{43}$/

export const DISPLAY_PREFIX_LENGTH = 10

export const MAX_APP_TOKEN_SECONDS = 60 * 60

export const LAST_USED_RESOLUTION_MS = 60 * 1000

export const isTokenScope = (value: unknown): value is TokenScope => typeof value === 'string' && (TOKEN_SCOPES as readonly string[]).includes(value)

export const parseScopes = (text: string): TokenScope[] => text.split(' ').filter(isTokenScope)

export const formatScopes = (scopes: readonly TokenScope[]): string => {
  for (const scope of scopes) if (!isTokenScope(scope)) throw new TypeError(`unknown scope ${String(scope)}`)
  return [...new Set(scopes)].sort().join(' ')
}

export const scopeCeiling = (scopes: readonly TokenScope[]): Access => {
  if (scopes.includes('repo:admin')) return 'admin'
  if (scopes.includes('repo:write')) return 'write'
  if (scopes.includes('repo:read')) return 'read'
  return 'none'
}

export type AccessChoice = {
  readonly scope: TokenScope
  readonly label: string
}

export const ACCESS_CHOICES: readonly AccessChoice[] = [
  { scope: 'repo:read', label: 'read' },
  { scope: 'repo:write', label: 'write (includes read)' },
  { scope: 'repo:admin', label: 'admin (includes write)' },
]

const scopeRank = (scope: TokenScope): number => TOKEN_SCOPES.indexOf(scope)

export const accessChoices = (max: TokenScope = 'repo:admin'): readonly AccessChoice[] => ACCESS_CHOICES.filter((choice) => scopeRank(choice.scope) <= scopeRank(max))

export const highestScope = (scopes: readonly TokenScope[]): TokenScope | null => {
  const ceiling = scopeCeiling(scopes)
  return ceiling === 'none' ? null : (`repo:${ceiling}` as TokenScope)
}

export const parseRequestedScope = (text: string | null | undefined, fallback: TokenScope = 'repo:write'): TokenScope | null => {
  if (text === null || text === undefined || text.trim() === '') return fallback
  const words = text.trim().split(/\s+/)
  if (!words.every(isTokenScope)) return null
  return highestScope(words as TokenScope[])
}

export const grantedScope = (requested: TokenScope, chosen: string | null | undefined): TokenScope => {
  if (!isTokenScope(chosen)) return requested
  return scopeRank(chosen) < scopeRank(requested) ? chosen : requested
}

export const tokenKindOf = (token: string): TokenKind | null => {
  const match = TOKEN_PATTERN.exec(token)
  if (!match) return null
  return match[1] === 'gfp' ? 'personal' : 'app'
}

export type GeneratedToken = {
  readonly token: string
  readonly hash: string
  readonly displayPrefix: string
}

export const hashToken = (token: string): Promise<string> => sha256Hex(token)

export const generateToken = async (kind: TokenKind): Promise<GeneratedToken> => {
  const token = `${PREFIXES[kind]}${base64UrlEncode(randomBytes(32))}`
  return { token, hash: await hashToken(token), displayPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH) }
}

export type TokenState = {
  readonly expiresAt: number | null
  readonly revokedAt: number | null
}

export type TokenStatus = 'active' | 'expired' | 'revoked'

export const tokenStatus = (token: TokenState, now: number): TokenStatus => {
  if (token.revokedAt !== null && token.revokedAt <= now) return 'revoked'
  if (token.expiresAt !== null && token.expiresAt <= now) return 'expired'
  return 'active'
}

export const shouldRecordUse = (lastUsedAt: number | null, now: number): boolean =>
  lastUsedAt === null || now - lastUsedAt >= LAST_USED_RESOLUTION_MS
