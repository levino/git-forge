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

export const MIRROR_ATTESTATION_SUBJECT = 'mirror-attestation'

export const MIRROR_OVERVIEW_SUBJECT = 'mirror-overview'

export const ATTESTATIONS_PATH = '/api/federation/attestations'

const CHECKSUM = /^[0-9a-f]{40}$/

const NAMESPACE = /^$|^upstream\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/$/

export type MirrorAttestation = {
  readonly repository: string
  readonly checksum: string
  readonly refs: number
  readonly namespace: string
  readonly syncedAt: string
  readonly alarms: number
  readonly pending: number
  readonly deepCheck?: { readonly at: string; readonly ok: boolean }
  readonly url?: string
}

export type MintMirrorAttestationOptions = {
  readonly key: SigningKey
  readonly issuer: string
  readonly audience: string
  readonly attestation: MirrorAttestation
  readonly ttlSeconds?: number
  readonly now?: number
}

const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const validateAttestation = (claims: Record<string, unknown>): string | null => {
  if (typeof claims.repository !== 'string' || !REPOSITORY_NAME.test(claims.repository)) return 'repository'
  if (typeof claims.checksum !== 'string' || !CHECKSUM.test(claims.checksum)) return 'checksum'
  if (typeof claims.namespace !== 'string' || !NAMESPACE.test(claims.namespace)) return 'namespace'
  if (!isCount(claims.refs) || !isCount(claims.alarms) || !isCount(claims.pending)) return 'counts'
  if (!isTime(claims.synced_at)) return 'synced_at'
  if (claims.deep_check !== undefined) {
    const deep = claims.deep_check as Record<string, unknown> | null
    if (typeof deep !== 'object' || deep === null || !isTime(deep.at) || typeof deep.ok !== 'boolean') return 'deep_check'
  }
  if (claims.url !== undefined) {
    try {
      const url = new URL(claims.url as string)
      if (url.username || url.password || (url.protocol !== 'https:' && url.protocol !== 'http:')) return 'url'
    } catch {
      return 'url'
    }
  }
  return null
}

export const mintMirrorAttestation = async (options: MintMirrorAttestationOptions): Promise<string> => {
  const ttl = options.ttlSeconds ?? MAX_INSTANCE_TOKEN_SECONDS
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_INSTANCE_TOKEN_SECONDS) {
    throw new FederationError(`ttlSeconds must be an integer between 1 and ${MAX_INSTANCE_TOKEN_SECONDS}`)
  }
  const { attestation } = options
  const iat = Math.floor((options.now ?? Date.now()) / 1000)
  const claims: Record<string, unknown> = {
    iss: normalizeIssuer(options.issuer),
    aud: normalizeIssuer(options.audience),
    sub: MIRROR_ATTESTATION_SUBJECT,
    iat,
    nbf: iat,
    exp: iat + ttl,
    jti: randomId(),
    repository: attestation.repository.toLowerCase(),
    checksum: attestation.checksum,
    refs: attestation.refs,
    namespace: attestation.namespace,
    synced_at: attestation.syncedAt,
    alarms: attestation.alarms,
    pending: attestation.pending,
    ...(attestation.deepCheck ? { deep_check: attestation.deepCheck } : {}),
    ...(attestation.url ? { url: attestation.url } : {}),
  }
  const invalid = validateAttestation(claims)
  if (invalid) throw new FederationError(`invalid attestation: ${invalid}`)
  return signJwt(options.key, claims)
}

export type VerifiedAttestation = MirrorAttestation & {
  readonly issuer: string
  readonly id: string
  readonly keyThumbprint: string
}

export type MirrorAttestationResult =
  | { readonly ok: true; readonly attestation: VerifiedAttestation }
  | { readonly ok: false; readonly reason: VerifyFailure; readonly detail?: string }

export const verifyMirrorAttestation = async (token: string, options: VerifyInstanceTokenOptions): Promise<MirrorAttestationResult> => {
  const checked = await verifyFederationToken(token, options, MIRROR_ATTESTATION_SUBJECT, validateAttestation)
  if (!checked.ok) return checked.detail === undefined ? { ok: false, reason: checked.reason } : { ok: false, reason: checked.reason, detail: checked.detail }
  const { issuer, payload, jti, keyThumbprint } = checked.token
  const deep = payload.deep_check as { at: string; ok: boolean } | undefined
  return {
    ok: true,
    attestation: {
      issuer,
      id: jti,
      keyThumbprint,
      repository: (payload.repository as string).toLowerCase(),
      checksum: payload.checksum as string,
      refs: payload.refs as number,
      namespace: payload.namespace as string,
      syncedAt: payload.synced_at as string,
      alarms: payload.alarms as number,
      pending: payload.pending as number,
      ...(deep ? { deepCheck: { at: deep.at, ok: deep.ok } } : {}),
      ...(typeof payload.url === 'string' ? { url: payload.url } : {}),
    },
  }
}

export const signMirrorOverview = async (key: SigningKey, issuer: string, overview: Record<string, unknown>, now = Date.now()): Promise<string> => {
  const iat = Math.floor(now / 1000)
  return signJwt(key, { iss: normalizeIssuer(issuer), sub: MIRROR_OVERVIEW_SUBJECT, iat, nbf: iat, exp: iat + 24 * 60 * 60, overview })
}
