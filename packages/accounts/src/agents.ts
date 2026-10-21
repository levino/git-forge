import { cleanClientText, isPkceChallenge, LOOPBACK_HOSTS, pkceMatches } from './cli-login.ts'
import { type Database, first, sql } from './database.ts'
import { base64UrlEncode, randomBytes, randomId, sha256Hex } from './encoding.ts'
import { type AuditActor, auditStatement } from './store.ts'
import { grantedScope, highestScope, isTokenScope, parseScopes, type TokenScope } from './tokens.ts'

export const MCP_PATH = '/mcp'
export const OAUTH_AUTHORIZE_PATH = '/login/oauth/authorize'
export const OAUTH_TOKEN_PATH = '/login/oauth/token'
export const OAUTH_REGISTER_PATH = '/login/oauth/register'
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server'

const MINUTE_MS = 60 * 1000
export const AGENT_CODE_TTL_MS = 5 * MINUTE_MS
export const AGENT_ACCESS_TTL_MS = 60 * MINUTE_MS
export const AGENT_REFRESH_TTL_MS = 90 * 24 * 60 * MINUTE_MS
export const AGENT_TOKEN_DEFAULT_MINUTES = 60
export const AGENT_TOKEN_MAX_MINUTES = 24 * 60
export const DEFAULT_AGENT_SCOPE: TokenScope = 'repo:write'
const CLIENT_RETENTION_MS = 30 * 24 * 60 * MINUTE_MS
const MAX_REDIRECT_URIS = 10

export type AgentSecretKind = 'access' | 'refresh' | 'code'

const PREFIXES: Record<AgentSecretKind, string> = { access: 'gfm_', refresh: 'gfr_', code: 'gfo_' }

const SECRET = /^gf[mro]_[A-Za-z0-9_-]{43}$/

export const generateAgentSecret = (kind: AgentSecretKind): string => `${PREFIXES[kind]}${base64UrlEncode(randomBytes(32))}`

export const isAgentSecret = (value: unknown, kind: AgentSecretKind): value is string => typeof value === 'string' && SECRET.test(value) && value.startsWith(PREFIXES[kind])

const secretHash = (value: string): Promise<string> => sha256Hex(`git-forge agent\n${value}`)

export type RedirectTarget = { readonly uri: string; readonly host: string; readonly formAction: string; readonly loopback: boolean }

const BLOCKED_SCHEMES = ['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:']

const isLoopback = (url: URL): boolean => url.protocol === 'http:' && (LOOPBACK_HOSTS as readonly string[]).includes(url.hostname)

export const parseRedirectUri = (value: unknown): RedirectTarget | null => {
  if (typeof value !== 'string' || value.length > 512 || value.includes('#') || /[\s<>"']/.test(value)) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.username !== '' || url.password !== '') return null
  if (isLoopback(url)) return { uri: url.toString(), host: `${url.hostname} (this computer)`, formAction: 'http://127.0.0.1:* http://localhost:* http://[::1]:*', loopback: true }
  if (url.protocol === 'https:') return { uri: url.toString(), host: url.host, formAction: url.origin, loopback: false }
  if (url.protocol === 'http:' || BLOCKED_SCHEMES.includes(url.protocol) || !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return null
  return { uri: url.toString(), host: `${url.protocol} (an app on this computer)`, formAction: url.protocol, loopback: false }
}

const withoutPort = (uri: string): string => {
  const url = new URL(uri)
  url.port = ''
  return url.toString()
}

export const redirectMatches = (registered: readonly string[], presented: string): boolean => {
  const target = parseRedirectUri(presented)
  if (!target) return false
  return registered.some((uri) => uri === target.uri || (target.loopback && parseRedirectUri(uri)?.loopback === true && withoutPort(uri) === withoutPort(target.uri)))
}

export const mcpResource = (origin: string): string => `${origin}${MCP_PATH}`

export const resolveResource = (origin: string, value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return mcpResource(origin)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.hash !== '' || url.search !== '' || url.origin !== origin) return null
  const path = url.pathname.replace(/\/+$/, '')
  return path === '' || path === MCP_PATH ? mcpResource(origin) : null
}

export const parseAgentScope = (text: string | null | undefined): TokenScope | null => {
  const words = (text ?? '').split(/\s+/).filter((word) => word !== '' && word !== 'offline_access')
  if (words.length === 0) return DEFAULT_AGENT_SCOPE
  return words.every(isTokenScope) ? highestScope(words) : null
}

export type AgentGrant = { readonly scope: TokenScope; readonly repositoryIds: readonly string[] | null }

export type AgentTokenRequest = { readonly scope: TokenScope; readonly repositoryIds: readonly string[] | null; readonly ttlMinutes?: unknown }

export type ClampedToken = { readonly scope: TokenScope; readonly repositoryIds: readonly string[] | null; readonly ttlMs: number }

export const clampTtlMinutes = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), AGENT_TOKEN_MAX_MINUTES) : AGENT_TOKEN_DEFAULT_MINUTES

export const clampAgentToken = (grant: AgentGrant, request: AgentTokenRequest): ClampedToken | { readonly error: string } => {
  const scope = grantedScope(grant.scope, request.scope)
  const ttlMs = clampTtlMinutes(request.ttlMinutes) * MINUTE_MS
  if (grant.repositoryIds === null) return { scope, repositoryIds: request.repositoryIds, ttlMs }
  if (request.repositoryIds === null) return { scope, repositoryIds: grant.repositoryIds, ttlMs }
  if (!request.repositoryIds.every((id) => grant.repositoryIds!.includes(id))) return { error: 'this connection is limited to other repositories' }
  return { scope, repositoryIds: request.repositoryIds, ttlMs }
}

export type OAuthClient = {
  readonly id: string
  readonly name: string
  readonly uri: string | null
  readonly redirectUris: readonly string[]
}

export type ClientRegistration = {
  readonly name: string
  readonly uri: string | null
  readonly redirectUris: readonly string[]
  readonly softwareId: string | null
  readonly softwareVersion: string | null
}

export type RegistrationError = { readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata'; readonly description: string }

const optionalText = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? cleanClientText(value, '', max) || null : null)

export const parseClientRegistration = (body: Record<string, unknown>): ClientRegistration | RegistrationError => {
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) return { error: 'invalid_redirect_uri', description: `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs` }
  const targets = uris.map(parseRedirectUri)
  if (targets.some((target) => target === null)) return { error: 'invalid_redirect_uri', description: 'redirect URIs must be https, http on a loopback address, or a private-use scheme, without a fragment' }
  const grants = body.grant_types ?? ['authorization_code']
  if (!Array.isArray(grants) || !grants.every((grant) => grant === 'authorization_code' || grant === 'refresh_token')) return { error: 'invalid_client_metadata', description: 'grant_types may only contain authorization_code and refresh_token' }
  const responses = body.response_types ?? ['code']
  if (!Array.isArray(responses) || !responses.every((type) => type === 'code')) return { error: 'invalid_client_metadata', description: 'response_types may only contain code' }
  const clientUri = typeof body.client_uri === 'string' && body.client_uri.startsWith('https://') && URL.canParse(body.client_uri) ? new URL(body.client_uri).toString().slice(0, 256) : null
  return {
    name: cleanClientText(typeof body.client_name === 'string' ? body.client_name : null, 'Unnamed agent'),
    uri: clientUri,
    redirectUris: [...new Set(targets.map((target) => target!.uri))],
    softwareId: optionalText(body.software_id, 100),
    softwareVersion: optionalText(body.software_version, 50),
  }
}

export type AgentConnection = {
  readonly id: string
  readonly userId: string
  readonly login: string
  readonly clientId: string
  readonly name: string
  readonly clientName: string
  readonly redirectHost: string
  readonly scope: TokenScope
  readonly repositoryIds: readonly string[] | null
  readonly createdAt: number
  readonly lastUsedAt: number | null
}

export type AgentConnectionSummary = Omit<AgentConnection, 'login'> & { readonly activeTokens: number }

export type IssuedAgentTokens = { readonly accessToken: string; readonly refreshToken: string; readonly expiresIn: number; readonly scope: TokenScope }

export type AuthorizationCodeInput = {
  readonly clientId: string
  readonly userId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly resource: string
  readonly name: string
  readonly scope: TokenScope
  readonly repositoryIds: readonly string[] | null
}

export type CodeExchange = { readonly clientId: string; readonly code: string; readonly codeVerifier: string; readonly redirectUri: string | null; readonly resource: string }

type ConnectionRow = {
  id: string
  user_id: string
  login: string
  client_id: string
  name: string
  client_name: string
  redirect_host: string
  scopes: string
  repository_ids: string | null
  created_at: number
  last_used_at: number | null
}

const connectionOf = (row: ConnectionRow): AgentConnection => ({
  id: row.id,
  userId: row.user_id,
  login: row.login,
  clientId: row.client_id,
  name: row.name,
  clientName: row.client_name,
  redirectHost: row.redirect_host,
  scope: parseScopes(row.scopes)[0] ?? 'repo:read',
  repositoryIds: row.repository_ids ? (JSON.parse(row.repository_ids) as string[]) : null,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
})

const CONNECTION_COLUMNS = 'c.id, c.user_id, a.login, c.client_id, c.name, c.client_name, c.redirect_host, c.scopes, c.repository_ids, c.created_at, c.last_used_at'

export type AgentStore = ReturnType<typeof createAgentStore>

export const createAgentStore = (db: Database, options: { readonly now?: () => number } = {}) => {
  const now = options.now ?? Date.now

  const revokeStatements = (connectionId: string, actor: AuditActor, at: number, reason: string) => [
    sql('UPDATE agent_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', at, connectionId),
    sql('DELETE FROM agent_tokens WHERE connection_id = ?', connectionId),
    sql('UPDATE tokens SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL', at, connectionId),
    auditStatement(actor, { action: 'agent.revoke', subjectKind: 'agent', subjectId: connectionId, data: { reason } }, at),
  ]

  const revokeForReuse = async (connectionId: string | null, userId: string | null): Promise<void> => {
    if (connectionId && userId) await db.batch(revokeStatements(connectionId, { kind: 'user', id: userId }, now(), 'reused'))
  }

  const issue = async (connectionId: string, resource: string, scope: TokenScope): Promise<{ statements: ReturnType<typeof sql>[]; tokens: IssuedAgentTokens }> => {
    const at = now()
    const accessToken = generateAgentSecret('access')
    const refreshToken = generateAgentSecret('refresh')
    const insert = 'INSERT INTO agent_tokens (token_hash, kind, connection_id, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    return {
      statements: [
        sql(insert, await secretHash(accessToken), 'access', connectionId, resource, at, at + AGENT_ACCESS_TTL_MS),
        sql(insert, await secretHash(refreshToken), 'refresh', connectionId, resource, at, at + AGENT_REFRESH_TTL_MS),
      ],
      tokens: { accessToken, refreshToken, expiresIn: AGENT_ACCESS_TTL_MS / 1000, scope },
    }
  }

  return {
    registerClient: async (input: ClientRegistration, requestIp: string | null): Promise<OAuthClient & { readonly createdAt: number }> => {
      const id = randomId()
      const at = now()
      await db.run(
        sql(
          'INSERT INTO oauth_clients (id, name, uri, redirect_uris, software_id, software_version, request_ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id,
          input.name,
          input.uri,
          JSON.stringify(input.redirectUris),
          input.softwareId,
          input.softwareVersion,
          requestIp,
          at,
        ),
      )
      return { id, name: input.name, uri: input.uri, redirectUris: input.redirectUris, createdAt: at }
    },

    findClient: async (id: string | null | undefined): Promise<OAuthClient | null> => {
      if (typeof id !== 'string' || id.length > 64) return null
      const row = await first<{ id: string; name: string; uri: string | null; redirect_uris: string }>(db, sql('SELECT id, name, uri, redirect_uris FROM oauth_clients WHERE id = ?', id))
      return row ? { id: row.id, name: row.name, uri: row.uri, redirectUris: JSON.parse(row.redirect_uris) as string[] } : null
    },

    createCode: async (input: AuthorizationCodeInput): Promise<string> => {
      if (!isPkceChallenge(input.codeChallenge)) throw new TypeError('invalid code challenge')
      const code = generateAgentSecret('code')
      const at = now()
      await db.run(
        sql(
          'INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, name, scopes, repository_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          await secretHash(code),
          input.clientId,
          input.userId,
          input.redirectUri,
          input.codeChallenge,
          input.resource,
          input.name,
          input.scope,
          input.repositoryIds ? JSON.stringify(input.repositoryIds) : null,
          at,
          at + AGENT_CODE_TTL_MS,
        ),
      )
      return code
    },

    exchangeCode: async (input: CodeExchange): Promise<IssuedAgentTokens | null> => {
      if (!isAgentSecret(input.code, 'code')) return null
      const hash = await secretHash(input.code)
      const row = await first<{
        client_id: string
        user_id: string
        redirect_uri: string
        code_challenge: string
        resource: string
        name: string
        scopes: string
        repository_ids: string | null
        expires_at: number
        used_at: number | null
        connection_id: string | null
        client_name: string
      }>(
        db,
        sql(
          `SELECT o.client_id, o.user_id, o.redirect_uri, o.code_challenge, o.resource, o.name, o.scopes, o.repository_ids, o.expires_at, o.used_at, o.connection_id, c.name AS client_name
           FROM oauth_codes o JOIN oauth_clients c ON c.id = o.client_id JOIN accounts a ON a.id = o.user_id AND a.disabled_at IS NULL WHERE o.code_hash = ?`,
          hash,
        ),
      )
      if (!row) return null
      if (row.used_at !== null) {
        await revokeForReuse(row.connection_id, row.user_id)
        return null
      }
      const at = now()
      if (row.expires_at <= at || row.client_id !== input.clientId || (input.redirectUri !== null && row.redirect_uri !== input.redirectUri) || row.resource !== input.resource) return null
      if (!(await pkceMatches(input.codeVerifier, row.code_challenge))) return null
      const connectionId = randomId()
      const claimed = await db.run(sql('UPDATE oauth_codes SET used_at = ?, connection_id = ? WHERE code_hash = ? AND used_at IS NULL', at, connectionId, hash))
      if (claimed.changes !== 1) return null
      const scope = parseScopes(row.scopes)[0] ?? 'repo:read'
      const issued = await issue(connectionId, row.resource, scope)
      const redirectHost = parseRedirectUri(row.redirect_uri)?.host ?? row.redirect_uri
      await db.batch([
        sql(
          'INSERT INTO agent_connections (id, user_id, client_id, name, client_name, redirect_host, scopes, repository_ids, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          connectionId,
          row.user_id,
          row.client_id,
          row.name,
          row.client_name,
          redirectHost,
          row.scopes,
          row.repository_ids,
          at,
          at,
        ),
        ...issued.statements,
        auditStatement(
          { kind: 'user', id: row.user_id },
          { action: 'agent.connect', subjectKind: 'agent', subjectId: connectionId, data: { client: row.client_id, clientName: row.client_name, name: row.name, scopes: row.scopes, repositoryIds: row.repository_ids ? JSON.parse(row.repository_ids) : null } },
          at,
        ),
      ])
      return issued.tokens
    },

    refresh: async (input: { readonly clientId: string; readonly refreshToken: string; readonly resource: string }): Promise<IssuedAgentTokens | null> => {
      if (!isAgentSecret(input.refreshToken, 'refresh')) return null
      const hash = await secretHash(input.refreshToken)
      const row = await first<{ connection_id: string; resource: string; expires_at: number; used_at: number | null; client_id: string; user_id: string; scopes: string; revoked_at: number | null; disabled_at: number | null }>(
        db,
        sql(
          `SELECT t.connection_id, t.resource, t.expires_at, t.used_at, c.client_id, c.user_id, c.scopes, c.revoked_at, a.disabled_at
           FROM agent_tokens t JOIN agent_connections c ON c.id = t.connection_id JOIN accounts a ON a.id = c.user_id WHERE t.token_hash = ? AND t.kind = 'refresh'`,
          hash,
        ),
      )
      if (!row || row.revoked_at !== null || row.disabled_at !== null || row.client_id !== input.clientId) return null
      if (row.used_at !== null) {
        await revokeForReuse(row.connection_id, row.user_id)
        return null
      }
      const at = now()
      if (row.expires_at <= at || row.resource !== input.resource) return null
      const claimed = await db.run(sql("UPDATE agent_tokens SET used_at = ? WHERE token_hash = ? AND kind = 'refresh' AND used_at IS NULL", at, hash))
      if (claimed.changes !== 1) return null
      const issued = await issue(row.connection_id, row.resource, parseScopes(row.scopes)[0] ?? 'repo:read')
      await db.batch(issued.statements)
      return issued.tokens
    },

    authenticate: async (token: string, resource: string): Promise<AgentConnection | null> => {
      if (!isAgentSecret(token, 'access')) return null
      const at = now()
      const row = await first<ConnectionRow & { resource: string; expires_at: number }>(
        db,
        sql(
          `SELECT ${CONNECTION_COLUMNS}, t.resource, t.expires_at FROM agent_tokens t JOIN agent_connections c ON c.id = t.connection_id JOIN accounts a ON a.id = c.user_id
           WHERE t.token_hash = ? AND t.kind = 'access' AND c.revoked_at IS NULL AND a.disabled_at IS NULL`,
          await secretHash(token),
        ),
      )
      if (!row || row.expires_at <= at || row.resource !== resource) return null
      if (row.last_used_at === null || at - row.last_used_at >= MINUTE_MS) await db.run(sql('UPDATE agent_connections SET last_used_at = ? WHERE id = ?', at, row.id))
      return connectionOf(row)
    },

    listConnections: async (userId: string): Promise<AgentConnectionSummary[]> => {
      const rows = await db.all<ConnectionRow & { active_tokens: number }>(
        sql(
          `SELECT ${CONNECTION_COLUMNS}, (SELECT COUNT(*) FROM tokens t WHERE t.connection_id = c.id AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)) AS active_tokens
           FROM agent_connections c JOIN accounts a ON a.id = c.user_id WHERE c.user_id = ? AND c.revoked_at IS NULL ORDER BY c.created_at`,
          now(),
          userId,
        ),
      )
      return rows.map((row) => {
        const { login: _, ...connection } = connectionOf(row)
        return { ...connection, activeTokens: Number(row.active_tokens) }
      })
    },

    revokeConnection: async (userId: string, connectionId: string, actor: AuditActor = { kind: 'user', id: userId }): Promise<boolean> => {
      const row = await first<{ id: string }>(db, sql('SELECT id FROM agent_connections WHERE id = ? AND user_id = ? AND revoked_at IS NULL', connectionId, userId))
      if (!row) return false
      await db.batch(revokeStatements(connectionId, actor, now(), 'revoked'))
      return true
    },

    purgeExpired: async (graceMs: number = 60 * MINUTE_MS): Promise<{ codes: number; tokens: number; clients: number }> => {
      const at = now()
      const [codes, tokens, clients] = await db.batch([
        sql('DELETE FROM oauth_codes WHERE expires_at <= ?', at - graceMs),
        sql('DELETE FROM agent_tokens WHERE expires_at <= ? OR used_at <= ?', at - graceMs, at - graceMs),
        sql('DELETE FROM oauth_clients WHERE created_at <= ? AND NOT EXISTS (SELECT 1 FROM agent_connections c WHERE c.client_id = oauth_clients.id) AND NOT EXISTS (SELECT 1 FROM oauth_codes o WHERE o.client_id = oauth_clients.id)', at - CLIENT_RETENTION_MS),
      ])
      return { codes: codes!.changes, tokens: tokens!.changes, clients: clients!.changes }
    },
  }
}
