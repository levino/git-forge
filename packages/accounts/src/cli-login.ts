import { base64UrlEncode, randomBytes } from './encoding.ts'
import { pkceChallenge } from './oidc.ts'
import { constantTimeEqual } from './sessions.ts'

export const CLI_AUTHORIZE_PATH = '/login/cli'

export const CLI_TOKEN_PATH = '/login/cli/token'

export const CLI_OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob'

export const CLI_REQUEST_TTL_MS = 10 * 60 * 1000

export const CLI_START_PATH = '/login/cli/start'

export const AUTHORIZATION_CODE_GRANT = 'authorization_code'

export const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'] as const

export type CliRedirect = { readonly kind: 'loopback'; readonly uri: string } | { readonly kind: 'oob'; readonly uri: typeof CLI_OOB_REDIRECT }

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/

const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/

const STATE = /^[\x21-\x7e]{1,256}$/

export const parseCliRedirect = (value: string | null | undefined): CliRedirect | null => {
  if (value === CLI_OOB_REDIRECT) return { kind: 'oob', uri: CLI_OOB_REDIRECT }
  if (typeof value !== 'string' || value.length > 256) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '' || url.hash !== '' || value.includes('#')) return null
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(url.hostname)) return null
  return { kind: 'loopback', uri: url.toString() }
}

export const isPkceChallenge = (value: unknown): value is string => typeof value === 'string' && PKCE_CHALLENGE.test(value)

export const isPkceVerifier = (value: unknown): value is string => typeof value === 'string' && PKCE_VERIFIER.test(value)

export const isClientState = (value: unknown): value is string => typeof value === 'string' && STATE.test(value)

export const pkceMatches = async (verifier: string, challenge: string): Promise<boolean> => isPkceVerifier(verifier) && constantTimeEqual(await pkceChallenge(verifier), challenge)

export const generateCliCode = (): string => `gfc_${base64UrlEncode(randomBytes(24))}`

const CLI_REQUEST_ID = /^[A-Za-z0-9_-]{22}$/

export const generateCliRequestId = (): string => base64UrlEncode(randomBytes(16))

export const isCliRequestId = (value: unknown): value is string => typeof value === 'string' && CLI_REQUEST_ID.test(value)

export const cliRequestPath = (id: string): string => `${CLI_AUTHORIZE_PATH}/${id}`

export const loopbackRedirect = (redirectUri: string, params: Record<string, string>): string => {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

export const cleanClientText = (value: string | null | undefined, fallback: string, max = 100): string => {
  const cleaned = typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
  return cleaned === '' ? fallback : cleaned
}
