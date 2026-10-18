import { randomId } from './encoding.ts'
import {
  FederationError,
  MAX_INSTANCE_TOKEN_SECONDS,
  normalizeIssuer,
  REPOSITORY_NAME,
  type VerifyFailure,
  type VerifyInstanceTokenOptions,
  verifyFederationToken,
} from './federation.ts'
import { type SigningKey, signJwt } from './jwt.ts'
import type { InstancePrincipal } from './permissions.ts'

export const MIRROR_NOTIFICATION_SUBJECT = 'mirror-notification'

export const SUBSCRIPTIONS_PATH = '/api/federation/subscriptions'

export const NOTIFY_PATH_PREFIX = '/api/federation/notify/'

export const MAX_NOTIFIED_REFS = 1000

export const NOTIFICATION_MEDIA_TYPE = 'application/jwt'

const OBJECT_ID = /^[0-9a-f]{40}$/

const NOTIFIED_PREFIXES = ['refs/heads/', 'refs/tags/', 'refs/upstream/']

export const notifiedRefs = (refs: Readonly<Record<string, string>>): Record<string, string> | null => {
  const selected = Object.entries(refs)
    .filter(([name]) => NOTIFIED_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return selected.length > MAX_NOTIFIED_REFS ? null : Object.fromEntries(selected)
}

export type MintMirrorNotificationOptions = {
  readonly key: SigningKey
  readonly issuer: string
  readonly audience: string
  readonly repository: string
  readonly refs: Readonly<Record<string, string>>
  readonly ttlSeconds?: number
  readonly now?: number
}

export const mintMirrorNotification = async (options: MintMirrorNotificationOptions): Promise<string> => {
  const ttl = options.ttlSeconds ?? MAX_INSTANCE_TOKEN_SECONDS
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_INSTANCE_TOKEN_SECONDS) {
    throw new FederationError(`ttlSeconds must be an integer between 1 and ${MAX_INSTANCE_TOKEN_SECONDS}`)
  }
  if (!REPOSITORY_NAME.test(options.repository)) throw new FederationError(`invalid repository ${options.repository}`)
  const iat = Math.floor((options.now ?? Date.now()) / 1000)
  const refs = notifiedRefs(options.refs)
  return signJwt(options.key, {
    iss: normalizeIssuer(options.issuer),
    aud: normalizeIssuer(options.audience),
    sub: MIRROR_NOTIFICATION_SUBJECT,
    iat,
    nbf: iat,
    exp: iat + ttl,
    jti: randomId(),
    repository: options.repository.toLowerCase(),
    ...(refs ? { refs } : {}),
  })
}

export type MirrorNotification = {
  readonly issuer: string
  readonly repository: string
  readonly refs: Readonly<Record<string, string>> | null
  readonly id: string
  readonly keyThumbprint: string
}

export type MirrorNotificationResult =
  | { readonly ok: true; readonly notification: MirrorNotification }
  | { readonly ok: false; readonly reason: VerifyFailure; readonly detail?: string }

const validateNotification = (claims: Record<string, unknown>): string | null => {
  if (typeof claims.repository !== 'string' || !REPOSITORY_NAME.test(claims.repository)) return 'repository'
  const { refs } = claims
  if (refs === undefined) return null
  if (typeof refs !== 'object' || refs === null || Array.isArray(refs)) return 'refs'
  const entries = Object.entries(refs)
  if (entries.length > MAX_NOTIFIED_REFS) return 'refs'
  for (const [name, id] of entries) if (!name.startsWith('refs/') || typeof id !== 'string' || !OBJECT_ID.test(id)) return 'refs'
  return null
}

export const verifyMirrorNotification = async (token: string, options: VerifyInstanceTokenOptions): Promise<MirrorNotificationResult> => {
  const checked = await verifyFederationToken(token, options, MIRROR_NOTIFICATION_SUBJECT, validateNotification)
  if (!checked.ok) return checked.detail === undefined ? { ok: false, reason: checked.reason } : { ok: false, reason: checked.reason, detail: checked.detail }
  const { issuer, payload, jti, keyThumbprint } = checked.token
  return {
    ok: true,
    notification: {
      issuer,
      repository: (payload.repository as string).toLowerCase(),
      refs: (payload.refs as Record<string, string> | undefined) ?? null,
      id: jti,
      keyThumbprint,
    },
  }
}

export const validateCallback = (issuer: string, callback: string): string | null => {
  let url: URL
  try {
    url = new URL(callback)
  } catch {
    return 'callback is not a URL'
  }
  if (url.username || url.password || url.hash) return 'callback must not carry credentials or a fragment'
  if (!url.href.startsWith(`${normalizeIssuer(issuer)}/`)) return 'callback must be below the issuer URL'
  return null
}

export const authorizeSubscription = (principal: InstancePrincipal, repository: string, callback: string): string | null => {
  if (!REPOSITORY_NAME.test(repository)) return 'invalid repository'
  if (!principal.scopes.includes('git:read')) return 'token lacks git:read'
  if (!principal.repositories.includes(repository.toLowerCase())) return 'token does not name the repository'
  return validateCallback(principal.issuer, callback)
}

export const upstreamRepositoryUrl = (issuer: string, repository: string): string => `${normalizeIssuer(issuer)}/${repository}.git`

const canonicalGitUrl = (url: string): string => url.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase()

export const isMirrorOf = (mirrorUrl: string, issuer: string, repository: string): boolean =>
  canonicalGitUrl(mirrorUrl) === canonicalGitUrl(upstreamRepositoryUrl(issuer, repository))

export const parseUpstreamUrl = (url: string, issuer?: string): { readonly issuer: string; readonly repository: string } => {
  const match = /^(.*)\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99}?)(?:\.git)?\/?$/.exec(url)
  if (!match) throw new FederationError(`cannot parse upstream URL ${url}`)
  const [, base, owner, name] = match as unknown as [string, string, string, string]
  const resolved = normalizeIssuer(issuer ?? base)
  if (!isMirrorOf(url, resolved, `${owner}/${name}`)) throw new FederationError(`upstream URL ${url} is not below issuer ${resolved}`)
  return { issuer: resolved, repository: `${owner}/${name}` }
}
