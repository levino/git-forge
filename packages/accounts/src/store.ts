import { isValidName } from '@git-forge/core'
import { type Database, first, sql, type Statement } from './database.ts'
import { randomId } from './encoding.ts'
import { normalizeIssuer, type TrustedIssuer } from './federation.ts'
import type { Grants, OrganizationRole, OwnerKind, Principal, RepositorySubject, Visibility } from './permissions.ts'
import { NO_GRANTS } from './permissions.ts'
import { isRole, type Role } from './roles.ts'
import {
  formatScopes,
  generateToken,
  hashToken,
  MAX_APP_TOKEN_SECONDS,
  parseScopes,
  scopeCeiling,
  shouldRecordUse,
  tokenKindOf,
  type TokenScope,
  tokenStatus,
} from './tokens.ts'

export type AuditActor =
  | { readonly kind: 'system' }
  | { readonly kind: 'user'; readonly id: string }
  | { readonly kind: 'app'; readonly id: string }
  | { readonly kind: 'instance'; readonly id: string }

export const SYSTEM: AuditActor = { kind: 'system' }

export type AuditEntry = {
  readonly seq: number
  readonly at: number
  readonly actor: { readonly kind: string; readonly id: string | null }
  readonly action: string
  readonly subject: { readonly kind: string; readonly id: string } | null
  readonly repositoryId: string | null
  readonly data: Record<string, unknown>
}

type AuditInput = {
  readonly action: string
  readonly subjectKind?: string
  readonly subjectId?: string
  readonly repositoryId?: string
  readonly data?: Record<string, unknown>
}

export class AccountsError extends Error {}

export const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

export const TEAM_SLUG_PATTERN = LOGIN_PATTERN

const requireLogin = (login: string) => {
  if (!LOGIN_PATTERN.test(login)) throw new AccountsError(`invalid login ${login}`)
}

const requireRole = (role: string): Role => {
  if (!isRole(role)) throw new AccountsError(`invalid role ${role}`)
  return role
}

export type CreatedToken = {
  readonly id: string
  readonly token: string
  readonly expiresAt: number | null
}

export type TokenOptions = {
  readonly name: string
  readonly scopes: readonly TokenScope[]
  readonly expiresAt: number | null
  readonly repositoryIds?: readonly string[] | null
}

export type AccountsStoreOptions = {
  readonly now?: () => number
}

type RepositoryRow = {
  id: string
  name: string
  visibility: Visibility
  owner_id: string
  owner_login: string
  owner_kind: OwnerKind
  default_repository_role: Role | null
}

type TokenRow = {
  id: string
  kind: 'personal' | 'app'
  account_id: string | null
  app_id: string | null
  scopes: string
  repository_ids: string | null
  expires_at: number | null
  revoked_at: number | null
  last_used_at: number | null
  login: string | null
  account_disabled_at: number | null
  slug: string | null
  app_disabled_at: number | null
}

type GrantRow = { source: 'organization' | 'collaborator' | 'team'; role: string }

type AuditRow = {
  seq: number
  at: number
  actor_kind: string
  actor_id: string | null
  action: string
  subject_kind: string | null
  subject_id: string | null
  repository_id: string | null
  data: string
}

const toSubject = (row: RepositoryRow): RepositorySubject => ({
  id: row.id,
  owner: row.owner_login,
  name: row.name,
  ownerId: row.owner_id,
  ownerKind: row.owner_kind,
  visibility: row.visibility,
  defaultRole: row.default_repository_role,
})

const REPOSITORY_SELECT = `SELECT r.id, r.name, r.visibility, r.owner_id, a.login AS owner_login, a.kind AS owner_kind, a.default_repository_role
FROM repositories r JOIN accounts a ON a.id = r.owner_id`

export const createAccountsStore = (db: Database, options: AccountsStoreOptions = {}) => {
  const now = options.now ?? Date.now

  const audit = (actor: AuditActor, entry: AuditInput, at: number): Statement =>
    sql(
      'INSERT INTO audit_log (at, actor_kind, actor_id, action, subject_kind, subject_id, repository_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      at,
      actor.kind,
      actor.kind === 'system' ? null : actor.id,
      entry.action,
      entry.subjectKind ?? null,
      entry.subjectId ?? null,
      entry.repositoryId ?? null,
      JSON.stringify(entry.data ?? {}),
    )

  const write = async (actor: AuditActor, entry: AuditInput, statements: readonly Statement[]): Promise<void> => {
    await db.batch([...statements, audit(actor, entry, now())])
  }

  const requireAccount = async (id: string, kind: OwnerKind): Promise<void> => {
    const row = await first<{ kind: string }>(db, sql('SELECT kind FROM accounts WHERE id = ?', id))
    if (!row || row.kind !== kind) throw new AccountsError(`no ${kind} ${id}`)
  }

  const createAccount = async (
    kind: OwnerKind,
    input: { readonly login: string; readonly displayName?: string; readonly email?: string; readonly defaultRepositoryRole?: Role | null },
    actor: AuditActor,
  ): Promise<{ readonly id: string }> => {
    requireLogin(input.login)
    if (input.defaultRepositoryRole) requireRole(input.defaultRepositoryRole)
    const id = randomId()
    await write(actor, { action: `${kind}.create`, subjectKind: kind, subjectId: id, data: { login: input.login } }, [
      sql(
        'INSERT INTO accounts (id, kind, login, display_name, email, default_repository_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        kind,
        input.login,
        input.displayName ?? null,
        input.email ?? null,
        input.defaultRepositoryRole ?? null,
        now(),
      ),
    ])
    return { id }
  }

  const insertToken = async (
    kind: 'personal' | 'app',
    ownerColumn: 'account_id' | 'app_id',
    ownerId: string,
    options: TokenOptions,
    actor: AuditActor,
  ): Promise<CreatedToken> => {
    const scopes = formatScopes(options.scopes)
    if (options.expiresAt !== null && options.expiresAt <= now()) throw new AccountsError('expiry must be in the future')
    const generated = await generateToken(kind)
    const id = randomId()
    const repositoryIds = options.repositoryIds ? JSON.stringify([...options.repositoryIds]) : null
    await write(
      actor,
      {
        action: `token.create`,
        subjectKind: 'token',
        subjectId: id,
        data: { kind, owner: ownerId, name: options.name, scopes, expiresAt: options.expiresAt, repositoryIds: options.repositoryIds ?? null },
      },
      [
        sql(
          `INSERT INTO tokens (id, kind, ${ownerColumn}, name, token_hash, display_prefix, scopes, repository_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          kind,
          ownerId,
          options.name,
          generated.hash,
          generated.displayPrefix,
          scopes,
          repositoryIds,
          now(),
          options.expiresAt,
        ),
      ],
    )
    return { id, token: generated.token, expiresAt: options.expiresAt }
  }

  const store = {
    createUser: (input: { readonly login: string; readonly displayName?: string; readonly email?: string }, actor: AuditActor = SYSTEM) =>
      createAccount('user', input, actor),

    createOrganization: (
      input: { readonly login: string; readonly displayName?: string; readonly defaultRepositoryRole?: Role | null },
      actor: AuditActor = SYSTEM,
    ) => createAccount('organization', input, actor),

    disableAccount: async (accountId: string, actor: AuditActor = SYSTEM): Promise<void> => {
      await write(actor, { action: 'account.disable', subjectKind: 'account', subjectId: accountId }, [
        sql('UPDATE accounts SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL', now(), accountId),
      ])
    },

    linkExternalIdentity: async (
      userId: string,
      identity: { readonly issuer: string; readonly subject: string; readonly email?: string },
      actor: AuditActor = SYSTEM,
    ): Promise<void> => {
      await requireAccount(userId, 'user')
      await write(actor, { action: 'identity.link', subjectKind: 'user', subjectId: userId, data: { issuer: identity.issuer, subject: identity.subject } }, [
        sql(
          'INSERT INTO external_identities (issuer, subject, account_id, email, created_at) VALUES (?, ?, ?, ?, ?)',
          identity.issuer,
          identity.subject,
          userId,
          identity.email ?? null,
          now(),
        ),
      ])
    },

    findUserByExternalIdentity: async (issuer: string, subject: string): Promise<{ readonly id: string; readonly login: string } | null> =>
      first<{ id: string; login: string }>(
        db,
        sql(
          `SELECT a.id, a.login FROM external_identities e JOIN accounts a ON a.id = e.account_id
           WHERE e.issuer = ? AND e.subject = ? AND a.disabled_at IS NULL`,
          issuer,
          subject,
        ),
      ),

    findAccount: async (login: string): Promise<{ readonly id: string; readonly kind: OwnerKind; readonly login: string } | null> =>
      first<{ id: string; kind: OwnerKind; login: string }>(db, sql('SELECT id, kind, login FROM accounts WHERE login = ?', login)),

    setOrganizationMember: async (organizationId: string, userId: string, role: OrganizationRole, actor: AuditActor = SYSTEM): Promise<void> => {
      await requireAccount(organizationId, 'organization')
      await requireAccount(userId, 'user')
      await write(actor, { action: 'organization.member.set', subjectKind: 'user', subjectId: userId, data: { organizationId, role } }, [
        sql(
          `INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (organization_id, user_id) DO UPDATE SET role = excluded.role`,
          organizationId,
          userId,
          role,
          now(),
        ),
      ])
    },

    removeOrganizationMember: async (organizationId: string, userId: string, actor: AuditActor = SYSTEM): Promise<void> => {
      await write(actor, { action: 'organization.member.remove', subjectKind: 'user', subjectId: userId, data: { organizationId } }, [
        sql('DELETE FROM team_members WHERE user_id = ? AND team_id IN (SELECT id FROM teams WHERE organization_id = ?)', userId, organizationId),
        sql('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?', organizationId, userId),
      ])
    },

    createTeam: async (organizationId: string, input: { readonly slug: string; readonly name: string }, actor: AuditActor = SYSTEM) => {
      await requireAccount(organizationId, 'organization')
      if (!TEAM_SLUG_PATTERN.test(input.slug)) throw new AccountsError(`invalid team slug ${input.slug}`)
      const id = randomId()
      await write(actor, { action: 'team.create', subjectKind: 'team', subjectId: id, data: { organizationId, slug: input.slug } }, [
        sql('INSERT INTO teams (id, organization_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)', id, organizationId, input.slug, input.name, now()),
      ])
      return { id }
    },

    setTeamMember: async (teamId: string, userId: string, role: 'member' | 'maintainer' = 'member', actor: AuditActor = SYSTEM): Promise<void> => {
      const team = await first<{ organization_id: string }>(db, sql('SELECT organization_id FROM teams WHERE id = ?', teamId))
      if (!team) throw new AccountsError(`no team ${teamId}`)
      const member = await first(db, sql('SELECT 1 AS ok FROM organization_members WHERE organization_id = ? AND user_id = ?', team.organization_id, userId))
      if (!member) throw new AccountsError('team members must belong to the organization')
      await write(actor, { action: 'team.member.set', subjectKind: 'user', subjectId: userId, data: { teamId, role } }, [
        sql(
          `INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role`,
          teamId,
          userId,
          role,
          now(),
        ),
      ])
    },

    createRepository: async (
      input: { readonly ownerId: string; readonly name: string; readonly visibility: Visibility },
      actor: AuditActor = SYSTEM,
    ): Promise<{ readonly id: string }> => {
      if (!isValidName(input.name)) throw new AccountsError(`invalid repository name ${input.name}`)
      if (input.visibility !== 'public' && input.visibility !== 'private') throw new AccountsError(`invalid visibility ${String(input.visibility)}`)
      const owner = await first(db, sql('SELECT 1 AS ok FROM accounts WHERE id = ?', input.ownerId))
      if (!owner) throw new AccountsError(`no account ${input.ownerId}`)
      const id = randomId()
      await write(actor, { action: 'repository.create', subjectKind: 'repository', subjectId: id, repositoryId: id, data: { name: input.name, visibility: input.visibility } }, [
        sql('INSERT INTO repositories (id, owner_id, name, visibility, created_at) VALUES (?, ?, ?, ?, ?)', id, input.ownerId, input.name, input.visibility, now()),
      ])
      return { id }
    },

    setRepositoryVisibility: async (repositoryId: string, visibility: Visibility, actor: AuditActor = SYSTEM): Promise<void> => {
      await write(actor, { action: 'repository.visibility', subjectKind: 'repository', subjectId: repositoryId, repositoryId, data: { visibility } }, [
        sql('UPDATE repositories SET visibility = ? WHERE id = ?', visibility, repositoryId),
      ])
    },

    findRepository: async (owner: string, name: string): Promise<RepositorySubject | null> => {
      const row = await first<RepositoryRow>(db, sql(`${REPOSITORY_SELECT} WHERE a.login = ? AND r.name = ? AND a.disabled_at IS NULL`, owner, name))
      return row ? toSubject(row) : null
    },

    setCollaborator: async (repositoryId: string, userId: string, role: Role, actor: AuditActor = SYSTEM): Promise<void> => {
      requireRole(role)
      await requireAccount(userId, 'user')
      await write(actor, { action: 'repository.collaborator.set', subjectKind: 'user', subjectId: userId, repositoryId, data: { role } }, [
        sql(
          `INSERT INTO repository_collaborators (repository_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (repository_id, user_id) DO UPDATE SET role = excluded.role`,
          repositoryId,
          userId,
          role,
          now(),
        ),
      ])
    },

    removeCollaborator: async (repositoryId: string, userId: string, actor: AuditActor = SYSTEM): Promise<void> => {
      await write(actor, { action: 'repository.collaborator.remove', subjectKind: 'user', subjectId: userId, repositoryId }, [
        sql('DELETE FROM repository_collaborators WHERE repository_id = ? AND user_id = ?', repositoryId, userId),
      ])
    },

    setTeamRepositoryRole: async (repositoryId: string, teamId: string, role: Role, actor: AuditActor = SYSTEM): Promise<void> => {
      requireRole(role)
      const team = await first<{ organization_id: string }>(db, sql('SELECT organization_id FROM teams WHERE id = ?', teamId))
      const repo = await first<{ owner_id: string }>(db, sql('SELECT owner_id FROM repositories WHERE id = ?', repositoryId))
      if (!team || !repo || team.organization_id !== repo.owner_id) throw new AccountsError('teams can only be granted repositories of their organization')
      await write(actor, { action: 'repository.team.set', subjectKind: 'team', subjectId: teamId, repositoryId, data: { role } }, [
        sql(
          `INSERT INTO repository_teams (repository_id, team_id, role, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (repository_id, team_id) DO UPDATE SET role = excluded.role`,
          repositoryId,
          teamId,
          role,
          now(),
        ),
      ])
    },

    createPersonalAccessToken: async (userId: string, options: TokenOptions, actor: AuditActor = { kind: 'user', id: userId }): Promise<CreatedToken> => {
      await requireAccount(userId, 'user')
      return insertToken('personal', 'account_id', userId, options, actor)
    },

    createApp: async (input: { readonly ownerId: string; readonly slug: string; readonly name: string }, actor: AuditActor = SYSTEM) => {
      requireLogin(input.slug)
      const id = randomId()
      await write(actor, { action: 'app.create', subjectKind: 'app', subjectId: id, data: { slug: input.slug, ownerId: input.ownerId } }, [
        sql('INSERT INTO apps (id, owner_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)', id, input.ownerId, input.slug, input.name, now()),
      ])
      return { id }
    },

    disableApp: async (appId: string, actor: AuditActor = SYSTEM): Promise<void> => {
      await write(actor, { action: 'app.disable', subjectKind: 'app', subjectId: appId }, [
        sql('UPDATE apps SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL', now(), appId),
      ])
    },

    setAppRepositoryRole: async (appId: string, repositoryId: string, role: Role, actor: AuditActor = SYSTEM): Promise<void> => {
      requireRole(role)
      await write(actor, { action: 'app.repository.set', subjectKind: 'app', subjectId: appId, repositoryId, data: { role } }, [
        sql(
          `INSERT INTO app_repositories (app_id, repository_id, role, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id, repository_id) DO UPDATE SET role = excluded.role`,
          appId,
          repositoryId,
          role,
          now(),
        ),
      ])
    },

    createAppToken: async (
      appId: string,
      options: { readonly scopes: readonly TokenScope[]; readonly ttlSeconds?: number; readonly repositoryIds?: readonly string[] | null },
      actor: AuditActor = SYSTEM,
    ): Promise<CreatedToken> => {
      const ttl = options.ttlSeconds ?? MAX_APP_TOKEN_SECONDS
      if (ttl <= 0 || ttl > MAX_APP_TOKEN_SECONDS) throw new AccountsError(`app tokens live at most ${MAX_APP_TOKEN_SECONDS} seconds`)
      const app = await first<{ disabled_at: number | null }>(db, sql('SELECT disabled_at FROM apps WHERE id = ?', appId))
      if (!app || app.disabled_at !== null) throw new AccountsError(`no active app ${appId}`)
      return insertToken('app', 'app_id', appId, { name: 'app', scopes: options.scopes, expiresAt: now() + ttl * 1000, repositoryIds: options.repositoryIds ?? null }, actor)
    },

    revokeToken: async (tokenId: string, actor: AuditActor = SYSTEM): Promise<void> => {
      await write(actor, { action: 'token.revoke', subjectKind: 'token', subjectId: tokenId }, [
        sql('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), tokenId),
      ])
    },

    listTokens: async (owner: { readonly accountId: string } | { readonly appId: string }) =>
      (
        await db.all<{ id: string; name: string; display_prefix: string; scopes: string; created_at: number; expires_at: number | null; last_used_at: number | null; revoked_at: number | null }>(
          'accountId' in owner
            ? sql('SELECT id, name, display_prefix, scopes, created_at, expires_at, last_used_at, revoked_at FROM tokens WHERE account_id = ? ORDER BY created_at', owner.accountId)
            : sql('SELECT id, name, display_prefix, scopes, created_at, expires_at, last_used_at, revoked_at FROM tokens WHERE app_id = ? ORDER BY created_at', owner.appId),
        )
      ).map((row) => ({
        id: row.id,
        name: row.name,
        displayPrefix: row.display_prefix,
        scopes: parseScopes(row.scopes),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
        status: tokenStatus({ expiresAt: row.expires_at, revokedAt: row.revoked_at }, now()),
      })),

    authenticateToken: async (token: string): Promise<Principal | null> => {
      const kind = tokenKindOf(token)
      if (!kind) return null
      const row = await first<TokenRow>(
        db,
        sql(
          `SELECT t.id, t.kind, t.account_id, t.app_id, t.scopes, t.repository_ids, t.expires_at, t.revoked_at, t.last_used_at,
                  a.login, a.disabled_at AS account_disabled_at, ap.slug, ap.disabled_at AS app_disabled_at
           FROM tokens t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN apps ap ON ap.id = t.app_id
           WHERE t.token_hash = ?`,
          await hashToken(token),
        ),
      )
      const at = now()
      if (!row || row.kind !== kind || tokenStatus({ expiresAt: row.expires_at, revokedAt: row.revoked_at }, at) !== 'active') return null
      if (shouldRecordUse(row.last_used_at, at)) await db.run(sql('UPDATE tokens SET last_used_at = ? WHERE id = ?', at, row.id))
      const limits = {
        ceiling: scopeCeiling(parseScopes(row.scopes)),
        repositoryIds: row.repository_ids ? (JSON.parse(row.repository_ids) as string[]) : null,
      }
      if (row.kind === 'personal' && row.account_id && row.login && row.account_disabled_at === null) {
        return { kind: 'user', id: row.account_id, login: row.login, limits, tokenId: row.id }
      }
      if (row.kind === 'app' && row.app_id && row.slug && row.app_disabled_at === null) {
        return { kind: 'app', id: row.app_id, slug: row.slug, limits, tokenId: row.id }
      }
      return null
    },

    trustInstance: async (input: { readonly issuer: string; readonly pinnedThumbprint?: string | null }, actor: AuditActor = SYSTEM): Promise<void> => {
      const issuer = normalizeIssuer(input.issuer)
      await write(actor, { action: 'instance.trust', subjectKind: 'instance', subjectId: issuer, data: { pinnedThumbprint: input.pinnedThumbprint ?? null } }, [
        sql(
          `INSERT INTO trusted_instances (issuer, pinned_thumbprint, created_at) VALUES (?, ?, ?)
           ON CONFLICT (issuer) DO UPDATE SET pinned_thumbprint = excluded.pinned_thumbprint, disabled_at = NULL`,
          issuer,
          input.pinnedThumbprint ?? null,
          now(),
        ),
      ])
    },

    distrustInstance: async (issuer: string, actor: AuditActor = SYSTEM): Promise<void> => {
      const normalized = normalizeIssuer(issuer)
      await write(actor, { action: 'instance.distrust', subjectKind: 'instance', subjectId: normalized }, [
        sql('UPDATE trusted_instances SET disabled_at = ? WHERE issuer = ? AND disabled_at IS NULL', now(), normalized),
      ])
    },

    grantInstanceRepository: async (issuer: string, repositoryId: string, actor: AuditActor = SYSTEM): Promise<void> => {
      const normalized = normalizeIssuer(issuer)
      await write(actor, { action: 'instance.repository.grant', subjectKind: 'instance', subjectId: normalized, repositoryId, data: { role: 'read' } }, [
        sql(
          `INSERT INTO instance_repositories (issuer, repository_id, role, created_at) VALUES (?, ?, 'read', ?)
           ON CONFLICT (issuer, repository_id) DO NOTHING`,
          normalized,
          repositoryId,
          now(),
        ),
      ])
    },

    revokeInstanceRepository: async (issuer: string, repositoryId: string, actor: AuditActor = SYSTEM): Promise<void> => {
      const normalized = normalizeIssuer(issuer)
      await write(actor, { action: 'instance.repository.revoke', subjectKind: 'instance', subjectId: normalized, repositoryId }, [
        sql('DELETE FROM instance_repositories WHERE issuer = ? AND repository_id = ?', normalized, repositoryId),
      ])
    },

    lookupTrustedIssuer: async (issuer: string): Promise<TrustedIssuer | null> => {
      const row = await first<{ issuer: string; pinned_thumbprint: string | null }>(
        db,
        sql('SELECT issuer, pinned_thumbprint FROM trusted_instances WHERE issuer = ? AND disabled_at IS NULL', issuer),
      )
      return row ? { issuer: row.issuer, pinnedThumbprint: row.pinned_thumbprint } : null
    },

    grantsFor: async (principal: Principal, repo: RepositorySubject): Promise<Grants> => {
      switch (principal.kind) {
        case 'anonymous':
          return NO_GRANTS
        case 'user': {
          const rows = await db.all<GrantRow>(
            sql(
              `SELECT 'organization' AS source, role FROM organization_members WHERE organization_id = ? AND user_id = ?
               UNION ALL SELECT 'collaborator' AS source, role FROM repository_collaborators WHERE repository_id = ? AND user_id = ?
               UNION ALL SELECT 'team' AS source, rt.role AS role FROM repository_teams rt JOIN team_members tm ON tm.team_id = rt.team_id
                 WHERE rt.repository_id = ? AND tm.user_id = ?`,
              repo.ownerId,
              principal.id,
              repo.id,
              principal.id,
              repo.id,
              principal.id,
            ),
          )
          const organization = rows.find((row) => row.source === 'organization')?.role
          const collaborator = rows.find((row) => row.source === 'collaborator')?.role
          return {
            ...NO_GRANTS,
            organizationRole: organization === 'owner' || organization === 'member' ? organization : null,
            collaboratorRole: isRole(collaborator) ? collaborator : null,
            teamRoles: rows.filter((row) => row.source === 'team').map((row) => row.role).filter(isRole),
          }
        }
        case 'app': {
          const row = await first<{ role: string }>(db, sql('SELECT role FROM app_repositories WHERE app_id = ? AND repository_id = ?', principal.id, repo.id))
          return { ...NO_GRANTS, appRole: isRole(row?.role) ? row.role : null }
        }
        case 'instance': {
          const row = await first<{ role: string }>(
            db,
            sql(
              `SELECT ir.role FROM instance_repositories ir JOIN trusted_instances ti ON ti.issuer = ir.issuer
               WHERE ir.issuer = ? AND ir.repository_id = ? AND ti.disabled_at IS NULL`,
              principal.issuer,
              repo.id,
            ),
          )
          return { ...NO_GRANTS, instanceRole: row?.role === 'read' ? 'read' : null }
        }
      }
    },

    recordAudit: async (actor: AuditActor, entry: AuditInput): Promise<void> => {
      await db.run(audit(actor, entry, now()))
    },

    auditLog: async (filter: { readonly repositoryId?: string; readonly afterSeq?: number; readonly limit?: number } = {}): Promise<AuditEntry[]> => {
      const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000)
      const rows = await db.all<AuditRow>(
        filter.repositoryId === undefined
          ? sql('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?', filter.afterSeq ?? 0, limit)
          : sql('SELECT * FROM audit_log WHERE repository_id = ? AND seq > ? ORDER BY seq LIMIT ?', filter.repositoryId, filter.afterSeq ?? 0, limit),
      )
      return rows.map((row) => ({
        seq: row.seq,
        at: row.at,
        actor: { kind: row.actor_kind, id: row.actor_id },
        action: row.action,
        subject: row.subject_kind && row.subject_id ? { kind: row.subject_kind, id: row.subject_id } : null,
        repositoryId: row.repository_id,
        data: JSON.parse(row.data) as Record<string, unknown>,
      }))
    },
  }
  return store
}

export type AccountsStore = ReturnType<typeof createAccountsStore>
