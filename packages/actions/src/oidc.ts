import { base64UrlEncode, sha256, type SigningKey, utf8 } from '@git-forge/accounts'
import { effectivePermissions, grantsPermission } from '@git-forge/core'
import type { JobDefinition, RunDefinition } from './definitions.ts'
import type { JobRow, RunRow } from './store.ts'

export type IdTokenPublicJwk = Readonly<Record<string, string>> & { readonly kid: string; readonly alg: 'ES256' | 'EdDSA'; readonly use: 'sig' }

export type IdTokenKey = {
  readonly kid: string
  readonly privateKey: CryptoKey
  readonly publicJwk: IdTokenPublicJwk
}

export type Es256PrivateJwk = {
  readonly kty: 'EC'
  readonly crv: 'P-256'
  readonly x: string
  readonly y: string
  readonly d: string
}

export const TOKEN_SERVICE_PATH = '/_services/token'

export const ID_TOKEN_PATH = `${TOKEN_SERVICE_PATH}/idtoken`

export const ID_TOKEN_TTL_SECONDS = 300

export const ID_TOKEN_CLOCK_SKEW_SECONDS = 300

export const tokenIssuer = (serverUrl: string): string => `${serverUrl.replace(/\/+$/, '')}${TOKEN_SERVICE_PATH}`

export const idTokenRequestUrl = (serverUrl: string): string => `${serverUrl.replace(/\/+$/, '')}${ID_TOKEN_PATH}?api-version=2.0`

const ecThumbprint = async (jwk: { readonly crv: string; readonly x: string; readonly y: string }): Promise<string> =>
  base64UrlEncode(await sha256(JSON.stringify({ crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y })))

export const importEs256Key = async (jwk: Es256PrivateJwk): Promise<IdTokenKey> => {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || typeof jwk.d !== 'string') {
    throw new TypeError('expected a P-256 private JWK')
  }
  const privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const kid = await ecThumbprint(jwk)
  return { kid, privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' } }
}

export const generateEs256Key = async (): Promise<Es256PrivateJwk> => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  return { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y!, d: jwk.d! }
}

export const idTokenKeyFromInstanceKey = (key: SigningKey): IdTokenKey => ({ kid: key.kid, privateKey: key.privateKey, publicJwk: { ...key.publicJwk } })

export const idTokenAllowed = (run: Pick<RunRow, 'trusted'>, workflow: RunDefinition | null, job: JobDefinition): boolean =>
  run.trusted === 1 && grantsPermission(effectivePermissions(workflow?.workflow, job.job), 'id-token', 'write')

export type RepositoryFacts = {
  readonly id: string
  readonly ownerId: string
  readonly visibility: string
}

export type IdTokenClaimsInput = {
  readonly issuer: string
  readonly audience: string
  readonly serverUrl: string
  readonly run: RunRow
  readonly job: JobRow
  readonly jobKey: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly repository: RepositoryFacts | null
  readonly now: number
  readonly jti: string
}

export const idTokenSubject = (input: Pick<IdTokenClaimsInput, 'run' | 'job'>): string => {
  const repository = `repo:${input.run.owner}/${input.run.repo}`
  if (input.job.environment) return `${repository}:environment:${input.job.environment}`
  if (input.run.event === 'pull_request' || input.run.event === 'pull_request_target') return `${repository}:pull_request`
  return `${repository}:ref:${input.run.ref}`
}

export const idTokenClaims = (input: IdTokenClaimsInput): Record<string, string | number> => {
  const { run, job } = input
  const repository = `${run.owner}/${run.repo}`
  const seconds = Math.floor(input.now / 1000)
  const pullRequest = input.payload['pull_request'] as { readonly head?: { readonly ref?: string }; readonly base?: { readonly ref?: string } } | undefined
  const workflowRef = `${repository}/${run.workflow_path}@${run.ref}`
  return {
    jti: input.jti,
    sub: idTokenSubject(input),
    aud: input.audience,
    ref: run.ref,
    sha: run.sha,
    repository,
    repository_owner: run.owner,
    ...(input.repository ? { repository_id: input.repository.id, repository_owner_id: input.repository.ownerId, repository_visibility: input.repository.visibility } : {}),
    run_id: String(run.id),
    run_number: String(run.id),
    run_attempt: String(job.attempt),
    actor: run.actor,
    triggering_actor: run.actor,
    workflow: run.workflow_name,
    head_ref: pullRequest?.head?.ref ?? '',
    base_ref: pullRequest?.base?.ref ?? '',
    event_name: run.event,
    ref_type: run.ref.startsWith('refs/tags/') ? 'tag' : 'branch',
    ref_protected: 'false',
    ...(job.environment ? { environment: job.environment } : {}),
    job_workflow_ref: workflowRef,
    job_workflow_sha: run.sha,
    workflow_ref: workflowRef,
    workflow_sha: run.sha,
    runner_environment: 'self-hosted',
    ...(job.check_run_id !== null ? { check_run_id: String(job.check_run_id) } : {}),
    iss: input.issuer,
    nbf: seconds - ID_TOKEN_CLOCK_SKEW_SECONDS,
    iat: seconds,
    exp: seconds + ID_TOKEN_TTL_SECONDS,
  }
}

const SIGNING = { ES256: { name: 'ECDSA', hash: 'SHA-256' }, EdDSA: { name: 'Ed25519' } } as const

export const signIdToken = async (key: IdTokenKey, claims: Record<string, unknown>): Promise<string> => {
  const header = { typ: 'JWT', alg: key.publicJwk.alg, kid: key.kid }
  const signingInput = `${base64UrlEncode(utf8(JSON.stringify(header)))}.${base64UrlEncode(utf8(JSON.stringify(claims)))}`
  const signature = new Uint8Array(await crypto.subtle.sign(SIGNING[key.publicJwk.alg], key.privateKey, utf8(signingInput)))
  return `${signingInput}.${base64UrlEncode(signature)}`
}

export const ID_TOKEN_CLAIMS = [
  'jti',
  'sub',
  'aud',
  'ref',
  'sha',
  'repository',
  'repository_owner',
  'repository_id',
  'repository_owner_id',
  'repository_visibility',
  'run_id',
  'run_number',
  'run_attempt',
  'actor',
  'triggering_actor',
  'workflow',
  'head_ref',
  'base_ref',
  'event_name',
  'ref_type',
  'ref_protected',
  'environment',
  'job_workflow_ref',
  'job_workflow_sha',
  'workflow_ref',
  'workflow_sha',
  'runner_environment',
  'check_run_id',
  'iss',
  'nbf',
  'iat',
  'exp',
] as const

export const idTokenDiscovery = (serverUrl: string, keys: readonly IdTokenKey[]) => {
  const issuer = tokenIssuer(serverUrl)
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks`,
    subject_types_supported: ['public', 'pairwise'],
    response_types_supported: ['id_token'],
    claims_supported: [...ID_TOKEN_CLAIMS],
    id_token_signing_alg_values_supported: [...new Set(keys.map((key) => key.publicJwk.alg))],
    scopes_supported: ['openid'],
  }
}

export const idTokenJwks = (keys: readonly IdTokenKey[]) => ({ keys: keys.map((key) => ({ ...key.publicJwk })) })
