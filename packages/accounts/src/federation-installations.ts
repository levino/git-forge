import { isClientState, isPkceChallenge, pkceMatches } from './cli-login.ts'
import { type Database, first, sql } from './database.ts'
import { base64UrlEncode, randomBytes, randomId, sha256Hex } from './encoding.ts'
import {
  createInstanceVerifier,
  FederationError,
  INSTANCE_SCOPES,
  INSTANCE_SUBJECT,
  type InstanceScope,
  type JwksSource,
  MAX_INSTANCE_TOKEN_SECONDS,
  normalizeIssuer,
  REPOSITORY_NAME,
  type TrustLookup,
  type VerifyFailure,
  verifyFederationToken,
} from './federation.ts'
import { decodeJwt, type SigningKey, signJwt } from './jwt.ts'
import { createPkce } from './oidc.ts'
import type { InstancePrincipal } from './permissions.ts'
import { type AuditActor, auditStatement } from './store.ts'

export const AUTHORIZE_PATH = '/federation/authorize'

export const CALLBACK_PATH = '/federation/callback'

export const EXCHANGE_PATH = '/api/federation/installations/exchange'

export const INSTALLATION_PATH = '/api/federation/installation'

export const FEDERATION_CODE_MS = 10 * 60 * 1000

export type RepositorySelection = 'all' | 'selected'

export type FederationInstallation = {
  readonly id: string
  readonly issuer: string
  readonly subject: string
  readonly accountId: string
  readonly accountLogin: string
  readonly selection: RepositorySelection
  readonly scopes: readonly InstanceScope[]
  readonly grantedBy: string
  readonly grantedByLogin: string
  readonly createdAt: number
  readonly revokedAt: number | null
}

export type AuthorizeRequest = {
  readonly issuer: string
  readonly redirectUri: string
  readonly state: string
  readonly challenge: string
  readonly subject: string
  readonly login: string | null
  readonly scopes: readonly InstanceScope[]
}

const SUBJECT = /^[A-Za-z0-9._:@-]{1,200}$/

const isSubject = (value: unknown): value is string => typeof value === 'string' && SUBJECT.test(value) && value !== INSTANCE_SUBJECT

const parseScopes = (value: string): InstanceScope[] => {
  const scopes = [...new Set(value.split(' ').filter((item) => item.length > 0))]
  if (scopes.length === 0 || !scopes.every((scope): scope is InstanceScope => (INSTANCE_SCOPES as readonly string[]).includes(scope))) throw new FederationError('scope must be git:read and/or lfs:read')
  return scopes
}

export const isBelowIssuer = (issuer: string, value: string): boolean => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const base = new URL(issuer)
  return url.origin === base.origin && !url.username && !url.password && !url.hash && url.pathname.startsWith(`${base.pathname.replace(/\/+$/, '')}/`)
}

export const parseAuthorizeRequest = (params: { readonly get: (name: string) => string | null }): AuthorizeRequest => {
  const value = (name: string) => params.get(name) ?? ''
  const issuer = normalizeIssuer(value('client_id'))
  const redirectUri = value('redirect_uri')
  if (!isBelowIssuer(issuer, redirectUri)) throw new FederationError('redirect_uri must be below the client_id')
  if (!isClientState(value('state'))) throw new FederationError('invalid state')
  if (value('code_challenge_method') !== 'S256' || !isPkceChallenge(value('code_challenge'))) throw new FederationError('an S256 code_challenge is required')
  if (!isSubject(value('sub'))) throw new FederationError('invalid sub')
  const login = value('login').slice(0, 100)
  return { issuer, redirectUri, state: value('state'), challenge: value('code_challenge'), subject: value('sub'), login: login || null, scopes: parseScopes(value('scope') || INSTANCE_SCOPES.join(' ')) }
}

export const authorizeUrl = (upstream: string, request: Omit<AuthorizeRequest, 'scopes'>): string => {
  const url = new URL(`${normalizeIssuer(upstream)}${AUTHORIZE_PATH}`)
  url.search = new URLSearchParams({
    client_id: request.issuer,
    redirect_uri: request.redirectUri,
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: 'S256',
    scope: INSTANCE_SCOPES.join(' '),
    sub: request.subject,
    ...(request.login ? { login: request.login } : {}),
  }).toString()
  return url.toString()
}

const claimsOf = (issuer: string, audience: string, subject: string, now?: number) => {
  const iat = Math.floor((now ?? Date.now()) / 1000)
  return { iss: normalizeIssuer(issuer), aud: normalizeIssuer(audience), sub: subject, iat, nbf: iat, exp: iat + MAX_INSTANCE_TOKEN_SECONDS, jti: randomId() }
}

export type MintInstallationTokenOptions = {
  readonly key: SigningKey
  readonly issuer: string
  readonly audience: string
  readonly subject: string
  readonly installation: string
  readonly repositories: readonly string[]
  readonly scopes?: readonly InstanceScope[]
  readonly now?: number
}

export const mintInstallationToken = (options: MintInstallationTokenOptions): Promise<string> => {
  for (const repository of options.repositories) if (!REPOSITORY_NAME.test(repository)) throw new FederationError(`invalid repository ${repository}`)
  return signJwt(options.key, {
    ...claimsOf(options.issuer, options.audience, options.subject, options.now),
    installation: options.installation,
    repositories: options.repositories.map((repository) => repository.toLowerCase()),
    scope: (options.scopes ?? INSTANCE_SCOPES).join(' '),
  })
}

export const mintExchangeToken = (options: { readonly key: SigningKey; readonly issuer: string; readonly audience: string; readonly subject: string; readonly now?: number }): Promise<string> =>
  signJwt(options.key, claimsOf(options.issuer, options.audience, options.subject, options.now))

export type InstallationLookup = (id: string) => Promise<FederationInstallation | null>

export type VerifyInstallationOptions = {
  readonly audience: string
  readonly jwks: JwksSource
  readonly installation: InstallationLookup
  readonly now?: number
}

export type InstallationVerifyResult = { readonly ok: true; readonly principal: InstancePrincipal } | { readonly ok: false; readonly reason: VerifyFailure | 'revoked'; readonly detail?: string }

const validateInstallationClaims = (claims: Record<string, unknown>): string | null => {
  if (typeof claims.scope !== 'string') return 'scope'
  const { repositories } = claims
  if (!Array.isArray(repositories) || !repositories.every((name) => typeof name === 'string' && REPOSITORY_NAME.test(name))) return 'repositories'
  return null
}

export const verifyInstallationToken = async (token: string, options: VerifyInstallationOptions): Promise<InstallationVerifyResult> => {
  const id = decodeJwt(token)?.payload.installation
  if (typeof id !== 'string' || id.length === 0 || id.length > 100) return { ok: false, reason: 'malformed', detail: 'installation' }
  const installation = await options.installation(id)
  if (!installation || installation.revokedAt !== null) return { ok: false, reason: 'revoked' }
  const trust: TrustLookup = async (issuer) => (issuer === installation.issuer ? { issuer, pinnedThumbprint: null } : null)
  const checked = await verifyFederationToken(
    token,
    { audience: options.audience, trust, jwks: options.jwks, ...(options.now !== undefined ? { now: options.now } : {}) },
    (sub) => sub === installation.subject,
    validateInstallationClaims,
  )
  if (!checked.ok) return checked
  const { payload, jti } = checked.token
  const scopes = (payload.scope as string).split(' ').filter((scope) => (installation.scopes as readonly string[]).includes(scope))
  return {
    ok: true,
    principal: {
      kind: 'instance',
      issuer: installation.issuer,
      repositories: (payload.repositories as string[]).map((name) => name.toLowerCase()),
      scopes,
      tokenId: jti,
      installation: { id: installation.id, subject: installation.subject },
    },
  }
}

export const verifyExchangeToken = async (
  token: string,
  options: { readonly audience: string; readonly jwks: JwksSource; readonly issuer: string; readonly subject: string; readonly now?: number },
): Promise<boolean> => {
  const trust: TrustLookup = async (issuer) => (issuer === options.issuer ? { issuer, pinnedThumbprint: null } : null)
  const checked = await verifyFederationToken(
    token,
    { audience: options.audience, trust, jwks: options.jwks, ...(options.now !== undefined ? { now: options.now } : {}) },
    (sub) => sub === options.subject,
    (claims) => (claims.installation === undefined && claims.repositories === undefined ? null : 'claims'),
  )
  return checked.ok
}

export type FederationVerifierOptions = {
  readonly audience: string
  readonly trust: TrustLookup
  readonly jwks: JwksSource
  readonly openJwks: JwksSource
  readonly installation: InstallationLookup
}

export const createFederationVerifier = (options: FederationVerifierOptions) => {
  const instance = createInstanceVerifier({ audience: options.audience, trust: options.trust, jwks: options.jwks })
  return async (token: string): Promise<InstancePrincipal | null> => {
    if (decodeJwt(token)?.payload.installation === undefined) return instance(token)
    const result = await verifyInstallationToken(token, { audience: options.audience, jwks: options.openJwks, installation: options.installation, now: Date.now() })
    return result.ok ? result.principal : null
  }
}

type InstallationRow = {
  id: string
  issuer: string
  subject: string
  account_id: string
  account_login: string
  repository_selection: RepositorySelection
  scopes: string
  granted_by: string
  granted_by_login: string
  created_at: number
  revoked_at: number | null
}

const INSTALLATION_SELECT = `SELECT i.id, i.issuer, i.subject, i.account_id, a.login AS account_login, i.repository_selection, i.scopes, i.granted_by, g.login AS granted_by_login, i.created_at, i.revoked_at
  FROM federation_installations i JOIN accounts a ON a.id = i.account_id JOIN accounts g ON g.id = i.granted_by`

const toInstallation = (row: InstallationRow): FederationInstallation => ({
  id: row.id,
  issuer: row.issuer,
  subject: row.subject,
  accountId: row.account_id,
  accountLogin: row.account_login,
  selection: row.repository_selection,
  scopes: row.scopes.split(' ') as InstanceScope[],
  grantedBy: row.granted_by,
  grantedByLogin: row.granted_by_login,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
})

export type NewFederationInstallation = {
  readonly request: AuthorizeRequest
  readonly accountId: string
  readonly selection: RepositorySelection
  readonly repositoryIds: readonly string[]
  readonly grantedBy: string
}

export type FederationConnection = {
  readonly upstream: string
  readonly installation: string
  readonly userId: string
  readonly createdAt: number
}

type ConnectionRow = { upstream: string; installation_id: string; user_id: string; created_at: number }

const toConnection = (row: ConnectionRow): FederationConnection => ({ upstream: row.upstream, installation: row.installation_id, userId: row.user_id, createdAt: row.created_at })

export const createFederationInstallationStore = (db: Database, now: () => number = Date.now) => ({
  install: async (input: NewFederationInstallation): Promise<{ readonly installation: string; readonly code: string }> => {
    const id = randomId()
    const code = `gff_${base64UrlEncode(randomBytes(24))}`
    const at = now()
    const repositoryIds = input.selection === 'selected' ? [...new Set(input.repositoryIds)] : []
    await db.batch([
      sql(
        `INSERT INTO federation_installations (id, issuer, subject, account_id, repository_selection, scopes, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.request.issuer,
        input.request.subject,
        input.accountId,
        input.selection,
        input.request.scopes.join(' '),
        input.grantedBy,
        at,
      ),
      ...repositoryIds.map((repositoryId) => sql('INSERT INTO federation_installation_repositories (installation_id, repository_id) VALUES (?, ?)', id, repositoryId)),
      sql(
        'INSERT INTO federation_codes (code_hash, installation_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?)',
        await sha256Hex(code),
        id,
        input.request.redirectUri,
        input.request.challenge,
        at + FEDERATION_CODE_MS,
      ),
      auditStatement(
        { kind: 'user', id: input.grantedBy },
        { action: 'federation.install', subjectKind: 'instance', subjectId: input.request.issuer, data: { installation: id, subject: input.request.subject, account: input.accountId, selection: input.selection, repositories: repositoryIds } },
        at,
      ),
    ])
    return { installation: id, code }
  },

  codeInstallation: async (code: string): Promise<FederationInstallation | null> => {
    const row = await first<InstallationRow>(
      db,
      sql(`${INSTALLATION_SELECT} JOIN federation_codes c ON c.installation_id = i.id WHERE c.code_hash = ? AND c.used_at IS NULL AND c.expires_at > ?`, await sha256Hex(code), now()),
    )
    return row ? toInstallation(row) : null
  },

  redeemCode: async (code: string, redirectUri: string, verifier: string): Promise<boolean> => {
    const hash = await sha256Hex(code)
    const row = await first<{ redirect_uri: string; challenge: string }>(db, sql('SELECT redirect_uri, challenge FROM federation_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', hash, now()))
    if (!row || row.redirect_uri !== redirectUri || !(await pkceMatches(verifier, row.challenge))) return false
    return (await db.run(sql('UPDATE federation_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', now(), hash))).changes === 1
  },

  installation: async (id: string): Promise<FederationInstallation | null> => {
    const row = await first<InstallationRow>(db, sql(`${INSTALLATION_SELECT} WHERE i.id = ?`, id))
    return row ? toInstallation(row) : null
  },

  installationsOn: async (accountIds: readonly string[]): Promise<FederationInstallation[]> =>
    accountIds.length === 0
      ? []
      : (
          await db.all<InstallationRow>(
            sql(`${INSTALLATION_SELECT} WHERE i.account_id IN (${accountIds.map(() => '?').join(', ')}) AND i.revoked_at IS NULL ORDER BY i.created_at DESC`, ...accountIds),
          )
        ).map(toInstallation),

  repositoryIds: async (id: string): Promise<string[]> =>
    (await db.all<{ repository_id: string }>(sql('SELECT repository_id FROM federation_installation_repositories WHERE installation_id = ? ORDER BY repository_id', id))).map((row) => row.repository_id),

  candidates: async (installation: FederationInstallation): Promise<{ readonly owner: string; readonly name: string }[]> =>
    db.all<{ owner: string; name: string }>(
      sql(
        `SELECT a.login AS owner, r.name FROM repositories r JOIN accounts a ON a.id = r.owner_id
         WHERE r.owner_id = ? AND r.deleted_at IS NULL AND (? = 'all' OR r.id IN (SELECT repository_id FROM federation_installation_repositories WHERE installation_id = ?))
         ORDER BY r.name`,
        installation.accountId,
        installation.selection,
        installation.id,
      ),
    ),

  revoke: async (id: string, actor: AuditActor): Promise<boolean> => {
    const at = now()
    const [result] = await db.batch([
      sql('UPDATE federation_installations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', at, id),
      auditStatement(actor, { action: 'federation.revoke', subjectKind: 'federation_installation', subjectId: id }, at),
    ])
    return (result?.changes ?? 0) === 1
  },

  subscribe: async (installation: string, repository: string, callback: string): Promise<void> => {
    await db.run(
      sql(
        'INSERT INTO federation_subscriptions (installation_id, repository, callback, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (installation_id, repository, callback) DO NOTHING',
        installation,
        repository.toLowerCase(),
        callback,
        now(),
      ),
    )
  },

  unsubscribe: async (installation: string, repository: string, callback: string): Promise<boolean> =>
    (await db.run(sql('DELETE FROM federation_subscriptions WHERE installation_id = ? AND repository = ? AND callback = ?', installation, repository.toLowerCase(), callback))).changes > 0,

  startRequest: async (input: { readonly userId: string; readonly sessionId: string | null; readonly upstream: string }): Promise<{ readonly state: string; readonly challenge: string }> => {
    const state = base64UrlEncode(randomBytes(24))
    const pkce = await createPkce()
    await db.batch([
      sql('DELETE FROM federation_requests WHERE expires_at <= ?', now()),
      sql(
        'INSERT INTO federation_requests (state_hash, user_id, session_id, upstream, verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        await sha256Hex(state),
        input.userId,
        input.sessionId,
        normalizeIssuer(input.upstream),
        pkce.verifier,
        now() + FEDERATION_CODE_MS,
      ),
    ])
    return { state, challenge: pkce.challenge }
  },

  takeRequest: async (state: string, userId: string, sessionId: string | null): Promise<{ readonly upstream: string; readonly verifier: string } | null> => {
    const hash = await sha256Hex(state)
    const row = await first<{ user_id: string; session_id: string | null; upstream: string; verifier: string; expires_at: number }>(
      db,
      sql('SELECT user_id, session_id, upstream, verifier, expires_at FROM federation_requests WHERE state_hash = ?', hash),
    )
    if (!row || row.user_id !== userId || (row.session_id !== null && row.session_id !== sessionId) || row.expires_at <= now()) return null
    return (await db.run(sql('DELETE FROM federation_requests WHERE state_hash = ?', hash))).changes === 1 ? { upstream: row.upstream, verifier: row.verifier } : null
  },

  connect: async (input: { readonly upstream: string; readonly installation: string; readonly userId: string }): Promise<FederationConnection> => {
    const at = now()
    await db.batch([
      sql(
        `INSERT INTO federation_connections (upstream, installation_id, user_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (upstream, installation_id) DO NOTHING`,
        input.upstream,
        input.installation,
        input.userId,
        at,
      ),
      auditStatement({ kind: 'user', id: input.userId }, { action: 'federation.connect', subjectKind: 'instance', subjectId: input.upstream, data: { installation: input.installation } }, at),
    ])
    const row = await first<ConnectionRow>(db, sql('SELECT * FROM federation_connections WHERE upstream = ? AND installation_id = ?', input.upstream, input.installation))
    if (!row || row.user_id !== input.userId) throw new FederationError('installation belongs to another user')
    return toConnection(row)
  },

  connection: async (upstream: string, installation: string): Promise<FederationConnection | null> => {
    const row = await first<ConnectionRow>(
      db,
      sql('SELECT c.* FROM federation_connections c JOIN accounts a ON a.id = c.user_id AND a.disabled_at IS NULL WHERE c.upstream = ? AND c.installation_id = ?', upstream, installation),
    )
    return row ? toConnection(row) : null
  },

  connectionsOf: async (userId: string): Promise<FederationConnection[]> =>
    (await db.all<ConnectionRow>(sql('SELECT * FROM federation_connections WHERE user_id = ? ORDER BY created_at DESC', userId))).map(toConnection),

  connectedIssuer: async (issuer: string): Promise<{ readonly issuer: string; readonly pinnedThumbprint: null } | null> =>
    (await first(db, sql('SELECT 1 AS ok FROM federation_connections WHERE upstream = ? LIMIT 1', issuer))) ? { issuer, pinnedThumbprint: null } : null,
})

export type FederationInstallationStore = ReturnType<typeof createFederationInstallationStore>
