import { isValidName } from '@git-forge/core'
import { type Database, first, sql, type Statement } from './database.ts'
import { randomId } from './encoding.ts'
import { normalizeIssuer, type TrustedIssuer } from './federation.ts'
import type { Grants, OrganizationRole, OwnerKind, Principal, RepositorySubject, Visibility } from './permissions.ts'
import { NO_GRANTS } from './permissions.ts'
import {
  type BranchProtectionRule,
  type BranchProtectionSettings,
  BranchPatternError,
  MAX_REQUIRED_APPROVALS,
  validateBranchPattern,
} from './protection.ts'
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

export type AuditInput = {
  readonly action: string
  readonly subjectKind?: string
  readonly subjectId?: string
  readonly repositoryId?: string
  readonly data?: Record<string, unknown>
}

export class AccountsError extends Error {}

export type MirrorSubscription = {
  readonly issuer: string
  readonly repository: string
  readonly callback: string
}

export const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

export const TEAM_SLUG_PATTERN = LOGIN_PATTERN

export const RESERVED_LOGINS: ReadonlySet<string> = new Set(['api', 'explore', 'login', 'logout', 'settings', 'notifications', 'organizations', 'orgs', 'new'])

export const isReservedLogin = (login: string): boolean => RESERVED_LOGINS.has(login.toLowerCase())

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

type ProtectionRow = {
  id: string
  repository_id: string
  pattern: string
  allow_force_pushes: number
  allow_deletions: number
  enforce_admins: number
  restrict_pushes: number
  require_pull_request: number
  required_approving_review_count: number
  dismiss_stale_reviews: number
  require_code_owner_reviews: number
  require_last_push_approval: number
  require_status_checks: number
  strict_status_checks: number
  created_at: number
  updated_at: number
}

type AllowanceRow = { rule_id: string; kind: 'user' | 'team' | 'app' | 'role'; subject: string }

type StatusCheckRow = { rule_id: string; context: string }

export type NamedAllowances = {
  readonly users: readonly { readonly id: string; readonly login: string }[]
  readonly teams: readonly { readonly id: string; readonly slug: string; readonly name: string }[]
  readonly apps: readonly { readonly id: string; readonly slug: string; readonly name: string }[]
}

const toRule = (row: ProtectionRow, allowances: readonly AllowanceRow[], checks: readonly StatusCheckRow[]): BranchProtectionRule => {
  const mine = allowances.filter((allowance) => allowance.rule_id === row.id)
  const of = (kind: AllowanceRow['kind']) => mine.filter((allowance) => allowance.kind === kind).map((allowance) => allowance.subject)
  return {
    id: row.id,
    repositoryId: row.repository_id,
    pattern: row.pattern,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    allowForcePushes: row.allow_force_pushes === 1,
    allowDeletions: row.allow_deletions === 1,
    enforceAdmins: row.enforce_admins === 1,
    restrictions: row.restrict_pushes === 1 ? { users: of('user'), teams: of('team'), apps: of('app'), roles: of('role').filter(isRole) } : null,
    requiredPullRequestReviews:
      row.require_pull_request === 1
        ? {
            requiredApprovingReviewCount: row.required_approving_review_count,
            dismissStaleReviews: row.dismiss_stale_reviews === 1,
            requireCodeOwnerReviews: row.require_code_owner_reviews === 1,
            requireLastPushApproval: row.require_last_push_approval === 1,
          }
        : null,
    requiredStatusChecks:
      row.require_status_checks === 1
        ? { strict: row.strict_status_checks === 1, contexts: checks.filter((check) => check.rule_id === row.id).map((check) => check.context) }
        : null,
  }
}

const flag = (value: boolean): number => (value ? 1 : 0)

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

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

export const auditStatement = (actor: AuditActor, entry: AuditInput, at: number): Statement =>
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

export const createAccountsStore = (db: Database, options: AccountsStoreOptions = {}) => {
  const now = options.now ?? Date.now

  const write = async (actor: AuditActor, entry: AuditInput, statements: readonly Statement[]): Promise<void> => {
    await db.batch([...statements, auditStatement(actor, entry, now())])
  }

  const requireAccount = async (id: string, kind: OwnerKind): Promise<void> => {
    const row = await first<{ kind: string }>(db, sql('SELECT kind FROM accounts WHERE id = ?', id))
    if (!row || row.kind !== kind) throw new AccountsError(`no ${kind} ${id}`)
  }

  const createAccount = async (
    kind: OwnerKind,
    input: {
      readonly id?: string
      readonly login: string
      readonly displayName?: string
      readonly email?: string
      readonly defaultRepositoryRole?: Role | null
    },
    actor: AuditActor,
  ): Promise<{ readonly id: string }> => {
    requireLogin(input.login)
    if (input.defaultRepositoryRole) requireRole(input.defaultRepositoryRole)
    const id = input.id ?? randomId()
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
    createUser: (
      input: { readonly id?: string; readonly login: string; readonly displayName?: string; readonly email?: string },
      actor: AuditActor = SYSTEM,
    ) =>
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

    addInstanceAdminClaim: async (identity: string): Promise<void> => {
      await db.run(sql('INSERT INTO instance_admin_claims (identity, created_at) VALUES (?, ?) ON CONFLICT (identity) DO NOTHING', identity, now()))
    },

    hasInstanceAdminClaim: async (identities: readonly string[]): Promise<boolean> => {
      const wanted = identities.filter((identity) => identity !== '')
      if (wanted.length === 0) return false
      const row = await first<{ ok: number }>(db, sql(`SELECT 1 AS ok FROM instance_admin_claims WHERE identity IN (${wanted.map(() => '?').join(', ')})`, ...wanted))
      return row !== null
    },

    redeemInstanceAdminClaim: async (userId: string, identities: readonly string[]): Promise<boolean> => {
      const wanted = identities.filter((identity) => identity !== '')
      if (wanted.length === 0) return false
      const at = now()
      const results = await db.batch([
        sql(
          `INSERT INTO instance_admins (user_id, created_at) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM instance_admin_claims WHERE identity IN (${wanted.map(() => '?').join(', ')}))
           ON CONFLICT (user_id) DO NOTHING`,
          userId,
          at,
          ...wanted,
        ),
        sql(`DELETE FROM instance_admin_claims WHERE identity IN (${wanted.map(() => '?').join(', ')})`, ...wanted),
        auditStatement(SYSTEM, { action: 'instance.admin.claim', subjectKind: 'user', subjectId: userId }, at),
      ])
      return results[1]!.changes > 0
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

    findUserById: async (id: string): Promise<{ readonly id: string; readonly login: string; readonly displayName: string | null; readonly email: string | null } | null> => {
      const row = await first<{ id: string; login: string; display_name: string | null; email: string | null }>(
        db,
        sql("SELECT id, login, display_name, email FROM accounts WHERE id = ? AND kind = 'user' AND disabled_at IS NULL", id),
      )
      return row ? { id: row.id, login: row.login, displayName: row.display_name, email: row.email } : null
    },

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

    organizationRole: async (organizationId: string, userId: string): Promise<OrganizationRole | null> =>
      (await first<{ role: OrganizationRole }>(db, sql('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?', organizationId, userId)))?.role ?? null,

    listOrganizationMembers: async (organizationId: string): Promise<{ readonly id: string; readonly login: string; readonly role: OrganizationRole }[]> =>
      db.all<{ id: string; login: string; role: OrganizationRole }>(
        sql('SELECT a.id, a.login, m.role FROM organization_members m JOIN accounts a ON a.id = m.user_id WHERE m.organization_id = ? ORDER BY a.login', organizationId),
      ),

    organizationsOf: async (userId: string): Promise<{ readonly id: string; readonly login: string; readonly role: OrganizationRole }[]> =>
      db.all<{ id: string; login: string; role: OrganizationRole }>(
        sql('SELECT a.id, a.login, m.role FROM organization_members m JOIN accounts a ON a.id = m.organization_id WHERE m.user_id = ? AND a.disabled_at IS NULL ORDER BY a.login', userId),
      ),

    listTeams: async (organizationId: string): Promise<{ readonly id: string; readonly slug: string; readonly name: string; readonly members: number }[]> =>
      db.all<{ id: string; slug: string; name: string; members: number }>(
        sql(
          'SELECT t.id, t.slug, t.name, (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS members FROM teams t WHERE t.organization_id = ? ORDER BY t.slug',
          organizationId,
        ),
      ),

    listTeamMembers: async (teamId: string): Promise<{ readonly id: string; readonly login: string; readonly role: 'member' | 'maintainer' }[]> =>
      db.all<{ id: string; login: string; role: 'member' | 'maintainer' }>(
        sql('SELECT a.id, a.login, m.role FROM team_members m JOIN accounts a ON a.id = m.user_id WHERE m.team_id = ? ORDER BY a.login', teamId),
      ),

    removeTeamMember: async (teamId: string, userId: string, actor: AuditActor = SYSTEM): Promise<void> => {
      await write(actor, { action: 'team.member.remove', subjectKind: 'user', subjectId: userId, data: { teamId } }, [
        sql('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId),
      ])
    },

    listTeamRepositories: async (teamId: string): Promise<{ readonly id: string; readonly name: string; readonly role: Role }[]> =>
      (
        await db.all<{ id: string; name: string; role: string }>(
          sql('SELECT r.id, r.name, t.role FROM repository_teams t JOIN repositories r ON r.id = t.repository_id WHERE t.team_id = ? ORDER BY r.name', teamId),
        )
      ).flatMap((row) => (isRole(row.role) ? [{ id: row.id, name: row.name, role: row.role }] : [])),

    removeTeamRepository: async (repositoryId: string, teamId: string, actor: AuditActor = SYSTEM): Promise<void> => {
      await write(actor, { action: 'repository.team.remove', subjectKind: 'team', subjectId: teamId, repositoryId }, [
        sql('DELETE FROM repository_teams WHERE repository_id = ? AND team_id = ?', repositoryId, teamId),
      ])
    },

    listExternalIdentities: async (userId: string): Promise<{ readonly issuer: string; readonly subject: string; readonly email: string | null; readonly createdAt: number }[]> =>
      (
        await db.all<{ issuer: string; subject: string; email: string | null; created_at: number }>(
          sql('SELECT issuer, subject, email, created_at FROM external_identities WHERE account_id = ? ORDER BY created_at', userId),
        )
      ).map((row) => ({ issuer: row.issuer, subject: row.subject, email: row.email, createdAt: row.created_at })),

    unlinkExternalIdentity: async (userId: string, issuer: string, subject: string, actor: AuditActor = SYSTEM): Promise<boolean> => {
      const linked = await first(db, sql('SELECT 1 AS ok FROM external_identities WHERE account_id = ? AND issuer = ? AND subject = ?', userId, issuer, subject))
      if (!linked) return false
      await write(actor, { action: 'identity.unlink', subjectKind: 'user', subjectId: userId, data: { issuer, subject } }, [
        sql('DELETE FROM external_identities WHERE account_id = ? AND issuer = ? AND subject = ?', userId, issuer, subject),
      ])
      return true
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

    listRepositories: async (): Promise<RepositorySubject[]> =>
      (await db.all<RepositoryRow>(sql(`${REPOSITORY_SELECT} WHERE a.disabled_at IS NULL ORDER BY a.login, r.name`))).map(toSubject),

    bootstrapInstanceAdmin: async (input: { readonly login: string; readonly email?: string }): Promise<{ readonly id: string } | null> => {
      requireLogin(input.login)
      const id = randomId()
      const at = now()
      const entry = auditStatement(SYSTEM, { action: 'instance.bootstrap', subjectKind: 'user', subjectId: id, data: { login: input.login } }, at)
      const results = await db.batch([
        sql(
          `INSERT INTO accounts (id, kind, login, email, created_at) SELECT ?, 'user', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM instance_admins)`,
          id,
          input.login,
          input.email ?? null,
          at,
        ),
        sql(
          'INSERT INTO instance_admins (user_id, created_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM instance_admins) AND EXISTS (SELECT 1 FROM accounts WHERE id = ?)',
          id,
          at,
          id,
        ),
        sql(`${entry.sql.replace('VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'SELECT ?, ?, ?, ?, ?, ?, ?, ?')} WHERE EXISTS (SELECT 1 FROM instance_admins WHERE user_id = ?)`, ...entry.params, id),
      ])
      return results[1]!.changes === 1 ? { id } : null
    },

    setInstanceAdmin: async (userId: string, admin: boolean, actor: AuditActor = SYSTEM): Promise<void> => {
      await requireAccount(userId, 'user')
      await write(actor, { action: admin ? 'instance.admin.grant' : 'instance.admin.revoke', subjectKind: 'user', subjectId: userId }, [
        admin
          ? sql('INSERT INTO instance_admins (user_id, created_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING', userId, now())
          : sql('DELETE FROM instance_admins WHERE user_id = ?', userId),
      ])
    },

    isInstanceAdmin: async (userId: string): Promise<boolean> =>
      (await first(db, sql('SELECT 1 AS ok FROM instance_admins i JOIN accounts a ON a.id = i.user_id WHERE i.user_id = ? AND a.disabled_at IS NULL', userId))) !== null,

    listInstanceAdmins: async (): Promise<{ readonly id: string; readonly login: string }[]> =>
      db.all<{ id: string; login: string }>(sql('SELECT a.id, a.login FROM instance_admins i JOIN accounts a ON a.id = i.user_id WHERE a.disabled_at IS NULL ORDER BY a.login')),

    listTrustedInstances: async (): Promise<{ readonly issuer: string; readonly pinnedThumbprint: string | null; readonly createdAt: number }[]> =>
      (
        await db.all<{ issuer: string; pinned_thumbprint: string | null; created_at: number }>(
          sql('SELECT issuer, pinned_thumbprint, created_at FROM trusted_instances WHERE disabled_at IS NULL ORDER BY issuer'),
        )
      ).map((row) => ({ issuer: row.issuer, pinnedThumbprint: row.pinned_thumbprint, createdAt: row.created_at })),

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

    listCollaborators: async (repositoryId: string): Promise<{ readonly id: string; readonly login: string; readonly role: Role }[]> =>
      (
        await db.all<{ id: string; login: string; role: string }>(
          sql('SELECT a.id, a.login, c.role FROM repository_collaborators c JOIN accounts a ON a.id = c.user_id WHERE c.repository_id = ? ORDER BY a.login', repositoryId),
        )
      ).flatMap((row) => (isRole(row.role) ? [{ id: row.id, login: row.login, role: row.role }] : [])),

    listInstanceGrants: async (repositoryId: string): Promise<{ readonly issuer: string; readonly role: string }[]> =>
      db.all<{ issuer: string; role: string }>(sql('SELECT issuer, role FROM instance_repositories WHERE repository_id = ? ORDER BY issuer', repositoryId)),

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

    subscribeMirror: async (input: MirrorSubscription, actor: AuditActor = SYSTEM): Promise<void> => {
      const issuer = normalizeIssuer(input.issuer)
      const repository = input.repository.toLowerCase()
      await write(actor, { action: 'mirror.subscribe', subjectKind: 'instance', subjectId: issuer, data: { repository, callback: input.callback } }, [
        sql(
          `INSERT INTO mirror_subscriptions (issuer, repository, callback, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (issuer, repository, callback) DO NOTHING`,
          issuer,
          repository,
          input.callback,
          now(),
        ),
      ])
    },

    unsubscribeMirror: async (input: MirrorSubscription, actor: AuditActor = SYSTEM): Promise<boolean> => {
      const issuer = normalizeIssuer(input.issuer)
      const repository = input.repository.toLowerCase()
      const existing = await first(
        db,
        sql('SELECT 1 AS found FROM mirror_subscriptions WHERE issuer = ? AND repository = ? AND callback = ?', issuer, repository, input.callback),
      )
      if (!existing) return false
      await write(actor, { action: 'mirror.unsubscribe', subjectKind: 'instance', subjectId: issuer, data: { repository, callback: input.callback } }, [
        sql('DELETE FROM mirror_subscriptions WHERE issuer = ? AND repository = ? AND callback = ?', issuer, repository, input.callback),
      ])
      return true
    },

    mirrorSubscriptions: async (repository: string): Promise<MirrorSubscription[]> =>
      (
        await db.all<{ issuer: string; repository: string; callback: string }>(
          sql(
            `SELECT s.issuer, s.repository, s.callback FROM mirror_subscriptions s
             JOIN trusted_instances t ON t.issuer = s.issuer AND t.disabled_at IS NULL
             WHERE s.repository = ? ORDER BY s.issuer, s.callback`,
            repository.toLowerCase(),
          ),
        )
      ).map((row) => ({ issuer: row.issuer, repository: row.repository, callback: row.callback })),

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

    findTeam: async (organizationId: string, slug: string): Promise<{ readonly id: string; readonly slug: string; readonly name: string } | null> =>
      first<{ id: string; slug: string; name: string }>(db, sql('SELECT id, slug, name FROM teams WHERE organization_id = ? AND slug = ?', organizationId, slug)),

    findApp: async (slug: string): Promise<{ readonly id: string; readonly slug: string; readonly name: string } | null> =>
      first<{ id: string; slug: string; name: string }>(db, sql('SELECT id, slug, name FROM apps WHERE slug = ?', slug)),

    teamIdsFor: async (userId: string, organizationId: string): Promise<string[]> =>
      (
        await db.all<{ id: string }>(
          sql('SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE t.organization_id = ? AND tm.user_id = ? ORDER BY t.id', organizationId, userId),
        )
      ).map((row) => row.id),

    branchProtectionRules: async (repositoryId: string): Promise<BranchProtectionRule[]> => {
      const rows = await db.all<ProtectionRow>(sql('SELECT * FROM branch_protection_rules WHERE repository_id = ? ORDER BY created_at, rowid', repositoryId))
      if (rows.length === 0) return []
      const allowances = await db.all<AllowanceRow>(
        sql(
          `SELECT a.rule_id, a.kind, a.subject FROM branch_protection_push_allowances a JOIN branch_protection_rules r ON r.id = a.rule_id
           WHERE r.repository_id = ? ORDER BY a.kind, a.subject`,
          repositoryId,
        ),
      )
      const checks = await db.all<StatusCheckRow>(
        sql(
          `SELECT c.rule_id, c.context FROM branch_protection_status_checks c JOIN branch_protection_rules r ON r.id = c.rule_id
           WHERE r.repository_id = ? ORDER BY c.context`,
          repositoryId,
        ),
      )
      return rows.map((row) => toRule(row, allowances, checks))
    },

    namedAllowances: async (rule: BranchProtectionRule): Promise<NamedAllowances> => {
      const restrictions = rule.restrictions
      if (!restrictions) return { users: [], teams: [], apps: [] }
      const placeholders = (ids: readonly string[]) => ids.map(() => '?').join(', ')
      const lookup = async <T extends Record<string, string>>(table: string, columns: string, ids: readonly string[]): Promise<T[]> =>
        ids.length === 0 ? [] : db.all<T>(sql(`SELECT ${columns} FROM ${table} WHERE id IN (${placeholders(ids)}) ORDER BY 2`, ...ids))
      return {
        users: await lookup<{ id: string; login: string }>('accounts', 'id, login', restrictions.users),
        teams: await lookup<{ id: string; slug: string; name: string }>('teams', 'id, slug, name', restrictions.teams),
        apps: await lookup<{ id: string; slug: string; name: string }>('apps', 'id, slug, name', restrictions.apps),
      }
    },

    setBranchProtection: async (
      repositoryId: string,
      pattern: string,
      settings: BranchProtectionSettings,
      actor: AuditActor = SYSTEM,
    ): Promise<BranchProtectionRule> => {
      try {
        validateBranchPattern(pattern)
      } catch (error) {
        if (error instanceof BranchPatternError) throw new AccountsError(error.message)
        throw error
      }
      const repo = await first<{ owner_id: string }>(db, sql('SELECT owner_id FROM repositories WHERE id = ?', repositoryId))
      if (!repo) throw new AccountsError(`no repository ${repositoryId}`)
      const reviews = settings.requiredPullRequestReviews
      if (reviews && (!Number.isInteger(reviews.requiredApprovingReviewCount) || reviews.requiredApprovingReviewCount < 0 || reviews.requiredApprovingReviewCount > MAX_REQUIRED_APPROVALS)) {
        throw new AccountsError(`required approving review count must be between 0 and ${MAX_REQUIRED_APPROVALS}`)
      }
      const contexts = unique(settings.requiredStatusChecks?.contexts ?? [])
      if (contexts.some((context) => context.trim() === '' || context.length > 255)) throw new AccountsError('status check names must have 1 to 255 characters')
      const restrictions = settings.restrictions
      const users = unique(restrictions?.users ?? [])
      const teams = unique(restrictions?.teams ?? [])
      const apps = unique(restrictions?.apps ?? [])
      const roles = unique(restrictions?.roles ?? [])
      for (const role of roles) requireRole(role)
      for (const id of users) await requireAccount(id, 'user')
      for (const id of teams) {
        const team = await first<{ organization_id: string }>(db, sql('SELECT organization_id FROM teams WHERE id = ?', id))
        if (!team || team.organization_id !== repo.owner_id) throw new AccountsError(`team ${id} does not belong to the repository's organization`)
      }
      for (const id of apps) {
        if (!(await first(db, sql('SELECT 1 AS ok FROM apps WHERE id = ?', id)))) throw new AccountsError(`no app ${id}`)
      }
      const existing = await first<{ id: string; created_at: number }>(
        db,
        sql('SELECT id, created_at FROM branch_protection_rules WHERE repository_id = ? AND pattern = ?', repositoryId, pattern),
      )
      const at = now()
      const id = existing?.id ?? randomId()
      const values = [
        flag(settings.allowForcePushes),
        flag(settings.allowDeletions),
        flag(settings.enforceAdmins),
        flag(restrictions !== null),
        flag(reviews !== null),
        reviews?.requiredApprovingReviewCount ?? 0,
        flag(reviews?.dismissStaleReviews ?? false),
        flag(reviews?.requireCodeOwnerReviews ?? false),
        flag(reviews?.requireLastPushApproval ?? false),
        flag(settings.requiredStatusChecks !== null),
        flag(settings.requiredStatusChecks?.strict ?? false),
      ]
      const upsert = existing
        ? sql(
            `UPDATE branch_protection_rules SET allow_force_pushes = ?, allow_deletions = ?, enforce_admins = ?, restrict_pushes = ?, require_pull_request = ?,
             required_approving_review_count = ?, dismiss_stale_reviews = ?, require_code_owner_reviews = ?, require_last_push_approval = ?,
             require_status_checks = ?, strict_status_checks = ?, updated_at = ? WHERE id = ?`,
            ...values,
            at,
            id,
          )
        : sql(
            `INSERT INTO branch_protection_rules (id, repository_id, pattern, allow_force_pushes, allow_deletions, enforce_admins, restrict_pushes,
             require_pull_request, required_approving_review_count, dismiss_stale_reviews, require_code_owner_reviews, require_last_push_approval,
             require_status_checks, strict_status_checks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            repositoryId,
            pattern,
            ...values,
            at,
            at,
          )
      const allowanceRows = [
        ...users.map((subject) => ['user', subject] as const),
        ...teams.map((subject) => ['team', subject] as const),
        ...apps.map((subject) => ['app', subject] as const),
        ...roles.map((subject) => ['role', subject] as const),
      ]
      await write(
        actor,
        {
          action: existing ? 'branch_protection.update' : 'branch_protection.create',
          subjectKind: 'branch_protection',
          subjectId: id,
          repositoryId,
          data: { pattern, ...settings },
        },
        [
          sql('DELETE FROM branch_protection_push_allowances WHERE rule_id = ?', id),
          sql('DELETE FROM branch_protection_status_checks WHERE rule_id = ?', id),
          upsert,
          ...(restrictions ? allowanceRows.map(([kind, subject]) => sql('INSERT INTO branch_protection_push_allowances (rule_id, kind, subject) VALUES (?, ?, ?)', id, kind, subject)) : []),
          ...(settings.requiredStatusChecks ? contexts.map((context) => sql('INSERT INTO branch_protection_status_checks (rule_id, context) VALUES (?, ?)', id, context)) : []),
        ],
      )
      const stored = (await store.branchProtectionRules(repositoryId)).find((rule) => rule.id === id)
      if (!stored) throw new AccountsError(`branch protection ${pattern} vanished`)
      return stored
    },

    deleteBranchProtection: async (repositoryId: string, pattern: string, actor: AuditActor = SYSTEM): Promise<boolean> => {
      const existing = await first<{ id: string }>(db, sql('SELECT id FROM branch_protection_rules WHERE repository_id = ? AND pattern = ?', repositoryId, pattern))
      if (!existing) return false
      await write(actor, { action: 'branch_protection.delete', subjectKind: 'branch_protection', subjectId: existing.id, repositoryId, data: { pattern } }, [
        sql('DELETE FROM branch_protection_push_allowances WHERE rule_id = ?', existing.id),
        sql('DELETE FROM branch_protection_status_checks WHERE rule_id = ?', existing.id),
        sql('DELETE FROM branch_protection_rules WHERE id = ?', existing.id),
      ])
      return true
    },

    recordAudit: async (actor: AuditActor, entry: AuditInput): Promise<void> => {
      await db.run(auditStatement(actor, entry, now()))
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
