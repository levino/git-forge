import { type Database, first, sql } from './database.ts'
import { base64UrlEncode, randomBytes, randomId, sha256, sha256Hex, toHex, utf8 } from './encoding.ts'
import { parseCompactJws, type RsaPublicJwk, verifyCompactJws } from './jose.ts'
import { MAX_APP_TOKEN_SECONDS, type TokenScope } from './tokens.ts'
import type { Role } from './roles.ts'
import type { AccountsStore, AuditActor } from './store.ts'

export const APP_PERMISSIONS = [
  'actions',
  'administration',
  'checks',
  'contents',
  'deployments',
  'discussions',
  'environments',
  'issues',
  'metadata',
  'pages',
  'pull_requests',
  'repository_hooks',
  'secrets',
  'statuses',
  'variables',
  'workflows',
  'members',
  'organization_administration',
  'organization_hooks',
] as const

export type PermissionLevel = 'read' | 'write' | 'admin'

export type AppPermissions = Readonly<Record<string, PermissionLevel>>

const LEVEL_RANK: Readonly<Record<PermissionLevel, number>> = { read: 1, write: 2, admin: 3 }

export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const parsePermissions = (value: unknown): AppPermissions => {
  if (value === undefined || value === null) return { metadata: 'read' }
  if (typeof value !== 'object' || Array.isArray(value)) throw new AppError(422, 'permissions must be an object')
  const out: Record<string, PermissionLevel> = { metadata: 'read' }
  for (const [name, level] of Object.entries(value)) {
    if (!(APP_PERMISSIONS as readonly string[]).includes(name)) throw new AppError(422, `unknown permission ${name}`)
    if (level !== 'read' && level !== 'write' && level !== 'admin') throw new AppError(422, `permission ${name} must be read or write`)
    out[name] = level
  }
  return out
}

export const permissionsRole = (permissions: AppPermissions): Role => {
  const levels = Object.entries(permissions)
  if (levels.some(([name, level]) => (name === 'administration' || name === 'repository_hooks' || name === 'secrets') && level !== 'read')) return 'admin'
  return levels.some(([, level]) => level !== 'read') ? 'write' : 'read'
}

export const roleScopes = (role: Role): TokenScope[] => (role === 'admin' ? ['repo:admin'] : role === 'read' ? ['repo:read'] : ['repo:write'])

export const permissionsWithin = (requested: AppPermissions, granted: AppPermissions): boolean =>
  Object.entries(requested).every(([name, level]) => granted[name] !== undefined && LEVEL_RANK[level] <= LEVEL_RANK[granted[name]!])

export type AppRow = {
  readonly id: string
  readonly owner_id: string
  readonly owner_login: string
  readonly owner_kind: 'user' | 'organization'
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly external_url: string | null
  readonly setup_url: string | null
  readonly redirect_url: string | null
  readonly public: number
  readonly permissions: string
  readonly events: string
  readonly client_id: string | null
  readonly created_at: number
  readonly updated_at: number | null
  readonly disabled_at: number | null
}

export type InstallationRow = {
  readonly id: number
  readonly app_id: string
  readonly app_slug: string
  readonly account_id: string
  readonly account_login: string
  readonly account_kind: 'user' | 'organization'
  readonly repository_selection: 'all' | 'selected'
  readonly permissions: string
  readonly role: Role
  readonly events: string
  readonly created_by: string | null
  readonly created_at: number
  readonly updated_at: number
  readonly suspended_at: number | null
}

export type AppInput = {
  readonly name?: unknown
  readonly description?: unknown
  readonly url?: unknown
  readonly setupUrl?: unknown
  readonly redirectUrl?: unknown
  readonly public?: unknown
  readonly permissions?: unknown
  readonly events?: unknown
}

const APP_SELECT = `SELECT ap.*, a.login AS owner_login, a.kind AS owner_kind FROM apps ap JOIN accounts a ON a.id = ap.owner_id`

const INSTALLATION_SELECT = `SELECT i.*, ap.slug AS app_slug, a.login AS account_login, a.kind AS account_kind FROM app_installations i
  JOIN apps ap ON ap.id = i.app_id JOIN accounts a ON a.id = i.account_id`

const optionalText = (value: unknown, name: string, max = 1000): string | null | undefined => {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.length > max) throw new AppError(422, `${name} must be a string of at most ${max} characters`)
  return value
}

const optionalUrl = (value: unknown, name: string): string | null | undefined => {
  const text = optionalText(value, name)
  if (text && !/^https?:\/\//i.test(text)) throw new AppError(422, `${name} must be an http(s) URL`)
  return text
}

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34)

const pem = (label: string, der: Uint8Array): string => {
  let binary = ''
  for (const byte of der) binary += String.fromCharCode(byte)
  const body = btoa(binary).replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

export const MANIFEST_CODE_MS = 60 * 60 * 1000

export const APP_JWT_MAX_SECONDS = 10 * 60

export const createAppsStore = (db: Database, accounts: AccountsStore, now: () => number = Date.now) => {
  const appBy = (column: 'id' | 'slug' | 'client_id', value: string) => first<AppRow>(db, sql(`${APP_SELECT} WHERE ap.${column} = ?`, value))

  const installationById = (id: number) => first<InstallationRow>(db, sql(`${INSTALLATION_SELECT} WHERE i.id = ? AND i.deleted_at IS NULL`, id))

  const appColumns = (input: AppInput) => {
    const name = optionalText(input.name, 'name', 34)
    const events = input.events === undefined ? undefined : input.events
    if (events !== undefined && (!Array.isArray(events) || events.some((event) => typeof event !== 'string'))) throw new AppError(422, 'events must be a list of event names')
    const permissions = input.permissions === undefined ? undefined : parsePermissions(input.permissions)
    const pub = input.public === undefined ? undefined : input.public === true || input.public === 'true' || input.public === 'on'
    return {
      ...(name !== undefined ? { name } : {}),
      ...(optionalText(input.description, 'description') !== undefined ? { description: optionalText(input.description, 'description') } : {}),
      ...(optionalUrl(input.url, 'url') !== undefined ? { external_url: optionalUrl(input.url, 'url') } : {}),
      ...(optionalUrl(input.setupUrl, 'setup_url') !== undefined ? { setup_url: optionalUrl(input.setupUrl, 'setup_url') } : {}),
      ...(optionalUrl(input.redirectUrl, 'redirect_url') !== undefined ? { redirect_url: optionalUrl(input.redirectUrl, 'redirect_url') } : {}),
      ...(pub !== undefined ? { public: pub ? 1 : 0 } : {}),
      ...(permissions ? { permissions: JSON.stringify(permissions) } : {}),
      ...(events ? { events: JSON.stringify([...new Set(events as string[])]) } : {}),
    }
  }

  const update = async (id: string, columns: Record<string, unknown>): Promise<void> => {
    const entries = Object.entries(columns)
    if (entries.length === 0) return
    await db.run(sql(`UPDATE apps SET ${entries.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...(entries.map(([, value]) => value) as (string | number | null)[]), now(), id))
  }

  const revokeInstallationTokens = (installationId: number) =>
    db.run(sql('UPDATE tokens SET revoked_at = ? WHERE installation_id = ? AND revoked_at IS NULL', now(), installationId))

  const store = {
    app: (id: string) => appBy('id', id),
    appBySlug: (slug: string) => appBy('slug', slug),

    appsOwnedBy: (accountIds: readonly string[]): Promise<AppRow[]> =>
      accountIds.length === 0 ? Promise.resolve([]) : db.all<AppRow>(sql(`${APP_SELECT} WHERE ap.owner_id IN (${accountIds.map(() => '?').join(', ')}) AND ap.client_id IS NOT NULL ORDER BY ap.name`, ...accountIds)),

    createApp: async (ownerId: string, input: AppInput, actor: AuditActor): Promise<AppRow> => {
      const columns = appColumns(input)
      if (!columns.name) throw new AppError(422, 'name is required')
      const base = slugOf(columns.name)
      if (!base) throw new AppError(422, 'name must contain letters or digits')
      let slug = base
      for (let attempt = 2; await appBy('slug', slug); attempt++) slug = `${base}-${attempt}`
      const { id } = await accounts.createApp({ ownerId, slug, name: columns.name }, actor)
      await update(id, { ...columns, client_id: `Iv1.${toHex(randomBytes(8))}`, permissions: columns.permissions ?? JSON.stringify({ metadata: 'read' }) })
      return (await appBy('id', id))!
    },

    updateApp: async (id: string, input: AppInput): Promise<AppRow> => {
      await update(id, appColumns(input))
      return (await appBy('id', id))!
    },

    deleteApp: async (id: string, actor: AuditActor): Promise<InstallationRow[]> => {
      const installations = await store.installationsOf(id)
      for (const installation of installations) await store.uninstall(installation.id)
      await db.run(sql('UPDATE webhooks SET active = 0 WHERE app_id = ?', id))
      await accounts.disableApp(id, actor)
      return installations
    },

    generateKey: async (appId: string): Promise<{ readonly id: string; readonly pem: string; readonly fingerprint: string }> => {
      const pair = (await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair
      const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
      const spki = new Uint8Array((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer)
      const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
      const fingerprint = `SHA256:${btoa(String.fromCharCode(...(await sha256(spki))))}`
      const id = randomId()
      await db.run(
        sql('INSERT INTO app_keys (id, app_id, public_jwk, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)', id, appId, JSON.stringify({ kty: 'RSA', n: jwk.n, e: jwk.e, kid: id }), fingerprint, now()),
      )
      return { id, pem: pem('PRIVATE KEY', pkcs8), fingerprint }
    },

    keys: (appId: string) =>
      db.all<{ id: string; fingerprint: string; created_at: number }>(sql('SELECT id, fingerprint, created_at FROM app_keys WHERE app_id = ? AND revoked_at IS NULL ORDER BY created_at', appId)),

    revokeKey: async (appId: string, keyId: string): Promise<void> => {
      await db.run(sql('UPDATE app_keys SET revoked_at = ? WHERE id = ? AND app_id = ?', now(), keyId, appId))
    },

    resetClientSecret: async (appId: string): Promise<string> => {
      const secret = toHex(randomBytes(20))
      await db.run(sql('UPDATE apps SET client_secret_hash = ? WHERE id = ?', await sha256Hex(secret), appId))
      return secret
    },

    verifyJwt: async (token: string): Promise<AppRow | null> => {
      const jws = parseCompactJws(token)
      if (!jws || jws.header.alg !== 'RS256') return null
      let claims: { iss?: unknown; iat?: unknown; exp?: unknown }
      try {
        claims = JSON.parse(new TextDecoder().decode(jws.payload)) as typeof claims
      } catch {
        return null
      }
      const issuer = typeof claims.iss === 'number' ? String(claims.iss) : claims.iss
      if (typeof issuer !== 'string' || typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return null
      const seconds = now() / 1000
      if (claims.exp <= seconds || claims.iat > seconds + 60 || claims.exp - claims.iat > APP_JWT_MAX_SECONDS + 60) return null
      const app = (await appBy('id', issuer)) ?? (await appBy('client_id', issuer))
      if (!app || app.disabled_at !== null) return null
      const keys = (await db.all<{ public_jwk: string }>(sql('SELECT public_jwk FROM app_keys WHERE app_id = ? AND revoked_at IS NULL', app.id))).map(
        (row) => JSON.parse(row.public_jwk) as RsaPublicJwk,
      )
      return (await verifyCompactJws(token, keys)) ? app : null
    },

    createManifestCode: async (appId: string): Promise<string> => {
      const code = base64UrlEncode(randomBytes(20))
      await db.run(sql('INSERT INTO app_manifest_codes (code_hash, app_id, expires_at) VALUES (?, ?, ?)', await sha256Hex(code), appId, now() + MANIFEST_CODE_MS))
      return code
    },

    redeemManifestCode: async (code: string): Promise<AppRow | null> => {
      const row = await first<{ app_id: string }>(
        db,
        sql('UPDATE app_manifest_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING app_id', now(), await sha256Hex(code), now()),
      )
      return row ? appBy('id', row.app_id) : null
    },

    installation: installationById,

    installationsOf: (appId: string): Promise<InstallationRow[]> => db.all<InstallationRow>(sql(`${INSTALLATION_SELECT} WHERE i.app_id = ? AND i.deleted_at IS NULL ORDER BY i.id`, appId)),

    installationsOn: (accountIds: readonly string[]): Promise<InstallationRow[]> =>
      accountIds.length === 0
        ? Promise.resolve([])
        : db.all<InstallationRow>(sql(`${INSTALLATION_SELECT} WHERE i.account_id IN (${accountIds.map(() => '?').join(', ')}) AND i.deleted_at IS NULL ORDER BY i.id`, ...accountIds)),

    installationFor: (appId: string, accountId: string) =>
      first<InstallationRow>(db, sql(`${INSTALLATION_SELECT} WHERE i.app_id = ? AND i.account_id = ? AND i.deleted_at IS NULL`, appId, accountId)),

    installationRepositoryIds: async (installation: InstallationRow): Promise<string[]> =>
      (
        await db.all<{ id: string }>(
          installation.repository_selection === 'all'
            ? sql('SELECT id FROM repositories WHERE owner_id = ? AND deleted_at IS NULL ORDER BY name', installation.account_id)
            : sql(
                'SELECT r.id FROM app_installation_repositories ir JOIN repositories r ON r.id = ir.repository_id WHERE ir.installation_id = ? AND r.deleted_at IS NULL ORDER BY r.name',
                installation.id,
              ),
        )
      ).map((row) => row.id),

    install: async (app: AppRow, accountId: string, selection: 'all' | 'selected', repositoryIds: readonly string[], createdBy: string): Promise<InstallationRow> => {
      if (await store.installationFor(app.id, accountId)) throw new AppError(422, 'the app is already installed on this account')
      const at = now()
      const permissions = JSON.parse(app.permissions) as AppPermissions
      const row = await first<{ id: number }>(
        db,
        sql(
          'INSERT INTO app_installations (app_id, account_id, repository_selection, permissions, role, events, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
          app.id,
          accountId,
          selection,
          app.permissions,
          permissionsRole(permissions),
          app.events,
          createdBy,
          at,
          at,
        ),
      )
      if (selection === 'selected') await store.setRepositories(row!.id, repositoryIds, [])
      return (await installationById(row!.id))!
    },

    setRepositories: async (installationId: number, add: readonly string[], remove: readonly string[]): Promise<void> => {
      const at = now()
      await db.batch([
        ...add.map((id) => sql('INSERT OR IGNORE INTO app_installation_repositories (installation_id, repository_id, created_at) VALUES (?, ?, ?)', installationId, id, at)),
        ...remove.map((id) => sql('DELETE FROM app_installation_repositories WHERE installation_id = ? AND repository_id = ?', installationId, id)),
        sql('UPDATE app_installations SET updated_at = ? WHERE id = ?', at, installationId),
      ])
    },

    setSelection: async (installationId: number, selection: 'all' | 'selected'): Promise<void> => {
      await db.run(sql('UPDATE app_installations SET repository_selection = ?, updated_at = ? WHERE id = ?', selection, now(), installationId))
      if (selection === 'all') await db.run(sql('DELETE FROM app_installation_repositories WHERE installation_id = ?', installationId))
    },

    acceptPermissions: async (installation: InstallationRow, app: AppRow): Promise<void> => {
      await db.run(
        sql(
          'UPDATE app_installations SET permissions = ?, role = ?, events = ?, updated_at = ? WHERE id = ?',
          app.permissions,
          permissionsRole(JSON.parse(app.permissions) as AppPermissions),
          app.events,
          now(),
          installation.id,
        ),
      )
      await revokeInstallationTokens(installation.id)
    },

    suspend: async (installationId: number, suspended: boolean): Promise<void> => {
      await db.run(sql('UPDATE app_installations SET suspended_at = ?, updated_at = ? WHERE id = ?', suspended ? now() : null, now(), installationId))
      if (suspended) await revokeInstallationTokens(installationId)
    },

    uninstall: async (installationId: number): Promise<void> => {
      await db.run(sql('UPDATE app_installations SET deleted_at = ?, updated_at = ? WHERE id = ?', now(), now(), installationId))
      await revokeInstallationTokens(installationId)
    },

    createInstallationToken: async (
      installation: InstallationRow,
      request: { readonly repositoryIds?: readonly string[]; readonly permissions?: AppPermissions },
    ): Promise<{ readonly token: string; readonly expiresAt: number; readonly permissions: AppPermissions; readonly repositoryIds: readonly string[] | null }> => {
      if (installation.suspended_at !== null) throw new AppError(403, 'This installation has been suspended')
      const granted = JSON.parse(installation.permissions) as AppPermissions
      const permissions = request.permissions ?? granted
      if (!permissionsWithin(permissions, granted)) throw new AppError(422, 'The permissions requested are not granted to this installation.')
      const available = await store.installationRepositoryIds(installation)
      const repositoryIds = request.repositoryIds ?? (installation.repository_selection === 'selected' ? available : null)
      if (repositoryIds?.some((id) => !available.includes(id))) throw new AppError(422, 'There is at least one repository that does not exist or is not accessible to the parent installation.')
      const created = await accounts.createAppToken(
        installation.app_id,
        { scopes: roleScopes(permissionsRole(permissions)), ttlSeconds: MAX_APP_TOKEN_SECONDS, repositoryIds, installationId: installation.id, permissions },
        { kind: 'app', id: installation.app_id },
      )
      return { token: created.token, expiresAt: created.expiresAt!, permissions, repositoryIds }
    },

    revokeToken: (tokenId: string) => accounts.revokeToken(tokenId, { kind: 'system' }),

    verifyClientSecret: async (app: AppRow, secret: string): Promise<boolean> => {
      const row = await first<{ client_secret_hash: string | null }>(db, sql('SELECT client_secret_hash FROM apps WHERE id = ?', app.id))
      return row?.client_secret_hash !== null && row?.client_secret_hash === (await sha256Hex(utf8(secret)))
    },
  }
  return store
}

export type AppsStore = ReturnType<typeof createAppsStore>
