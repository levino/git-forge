import { type Database, first, sql } from '@git-forge/accounts'
import { sha256Hex, toHex, utf8 } from '@git-forge/core'

export type BuildType = 'legacy' | 'workflow'

export type DeploymentSource = 'branch' | 'artifact' | 'upload'

export type DeploymentStatus = 'queued' | 'in_progress' | 'succeed' | 'failed' | 'cancelled'

export type SiteRow = {
  readonly repository_id: string
  readonly build_type: BuildType
  readonly source_branch: string | null
  readonly source_path: '/' | '/docs'
  readonly active_deployment_id: number | null
  readonly created_at: number
  readonly updated_at: number
}

export type DeploymentRow = {
  readonly id: number
  readonly repository_id: string
  readonly source: DeploymentSource
  readonly ref: string | null
  readonly commit_sha: string | null
  readonly artifact_id: string | null
  readonly artifact_url: string | null
  readonly status: DeploymentStatus
  readonly error: string | null
  readonly manifest: string | null
  readonly file_count: number | null
  readonly total_bytes: number | null
  readonly creator_kind: string
  readonly creator_id: string | null
  readonly creator_login: string | null
  readonly created_at: number
  readonly updated_at: number
}

export type Creator = { readonly kind: string; readonly id: string | null; readonly login: string | null }

export type SiteInput = {
  readonly buildType: BuildType
  readonly sourceBranch: string | null
  readonly sourcePath: '/' | '/docs'
}

export type DeploymentInput = {
  readonly source: DeploymentSource
  readonly ref?: string | null
  readonly commitSha?: string | null
  readonly artifactId?: string | null
  readonly artifactUrl?: string | null
}

export type PagesUser = { readonly id: string; readonly login: string }

export const GRANT_TTL_MS = 2 * 60 * 1000

export const PAGES_SESSION_TTL_MS = 12 * 60 * 60 * 1000

const randomToken = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

const hashOf = (token: string): string => sha256Hex(utf8(token))

export const createPagesStore = (db: Database, now: () => number = Date.now) => ({
  site: (repositoryId: string): Promise<SiteRow | null> => first<SiteRow>(db, sql('SELECT * FROM pages_sites WHERE repository_id = ?', repositoryId)),

  createSite: async (repositoryId: string, input: SiteInput): Promise<SiteRow | null> => {
    const at = now()
    const rows = await db.all<SiteRow>(
      sql(
        'INSERT INTO pages_sites (repository_id, build_type, source_branch, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (repository_id) DO NOTHING RETURNING *',
        repositoryId,
        input.buildType,
        input.sourceBranch,
        input.sourcePath,
        at,
        at,
      ),
    )
    return rows[0] ?? null
  },

  updateSite: async (repositoryId: string, input: SiteInput): Promise<SiteRow | null> => {
    const rows = await db.all<SiteRow>(
      sql(
        'UPDATE pages_sites SET build_type = ?, source_branch = ?, source_path = ?, updated_at = ? WHERE repository_id = ? RETURNING *',
        input.buildType,
        input.sourceBranch,
        input.sourcePath,
        now(),
        repositoryId,
      ),
    )
    return rows[0] ?? null
  },

  deleteSite: async (repositoryId: string): Promise<boolean> => (await db.run(sql('DELETE FROM pages_sites WHERE repository_id = ?', repositoryId))).changes > 0,

  createDeployment: async (repositoryId: string, input: DeploymentInput, creator: Creator): Promise<DeploymentRow> => {
    const at = now()
    const rows = await db.all<DeploymentRow>(
      sql(
        `INSERT INTO pages_deployments (repository_id, source, ref, commit_sha, artifact_id, artifact_url, status, creator_kind, creator_id, creator_login, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?) RETURNING *`,
        repositoryId,
        input.source,
        input.ref ?? null,
        input.commitSha ?? null,
        input.artifactId ?? null,
        input.artifactUrl ?? null,
        creator.kind,
        creator.id,
        creator.login,
        at,
        at,
      ),
    )
    return rows[0]!
  },

  deployment: (repositoryId: string, id: number): Promise<DeploymentRow | null> =>
    first<DeploymentRow>(db, sql('SELECT * FROM pages_deployments WHERE repository_id = ? AND id = ?', repositoryId, id)),

  deployments: (repositoryId: string, source: DeploymentSource | null, limit: number, offset: number): Promise<DeploymentRow[]> =>
    db.all<DeploymentRow>(
      sql(
        `SELECT * FROM pages_deployments WHERE repository_id = ? ${source ? 'AND source = ?' : ''} ORDER BY id DESC LIMIT ? OFFSET ?`,
        ...(source ? [repositoryId, source, limit, offset] : [repositoryId, limit, offset]),
      ),
    ),

  start: async (id: number): Promise<boolean> =>
    (await db.run(sql("UPDATE pages_deployments SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'queued'", now(), id))).changes > 0,

  fail: async (id: number, error: string): Promise<void> => {
    await db.run(sql("UPDATE pages_deployments SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'in_progress')", error.slice(0, 1000), now(), id))
  },

  cancel: async (id: number): Promise<boolean> =>
    (await db.run(sql("UPDATE pages_deployments SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued', 'in_progress')", now(), id))).changes > 0,

  complete: async (deployment: DeploymentRow, built: { readonly manifest: string; readonly fileCount: number; readonly totalBytes: number }): Promise<boolean> => {
    const at = now()
    const [finished] = await db.batch([
      sql(
        "UPDATE pages_deployments SET status = 'succeed', manifest = ?, file_count = ?, total_bytes = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'",
        built.manifest,
        built.fileCount,
        built.totalBytes,
        at,
        deployment.id,
      ),
      sql(
        `UPDATE pages_sites SET active_deployment_id = ?, updated_at = ?
         WHERE repository_id = ? AND (active_deployment_id IS NULL OR active_deployment_id < ?)
           AND EXISTS (SELECT 1 FROM pages_deployments WHERE id = ? AND status = 'succeed')`,
        deployment.id,
        at,
        deployment.repository_id,
        deployment.id,
        deployment.id,
      ),
    ])
    return (finished?.changes ?? 0) > 0
  },

  activeDeployment: (repositoryId: string): Promise<DeploymentRow | null> =>
    first<DeploymentRow>(
      db,
      sql('SELECT d.* FROM pages_sites s JOIN pages_deployments d ON d.id = s.active_deployment_id WHERE s.repository_id = ?', repositoryId),
    ),

  createGrant: async (userId: string, host: string): Promise<string> => {
    const code = randomToken()
    await db.run(sql('INSERT INTO pages_grants (code_hash, user_id, host, expires_at) VALUES (?, ?, ?, ?)', hashOf(code), userId, host, now() + GRANT_TTL_MS))
    return code
  },

  consumeGrant: async (code: string, host: string): Promise<string | null> => {
    const rows = await db.all<{ user_id: string }>(
      sql('UPDATE pages_grants SET used_at = ? WHERE code_hash = ? AND host = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id', now(), hashOf(code), host, now()),
    )
    return rows[0]?.user_id ?? null
  },

  createSession: async (userId: string, host: string): Promise<string> => {
    const token = randomToken()
    const at = now()
    await db.run(sql('INSERT INTO pages_sessions (token_hash, user_id, host, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', hashOf(token), userId, host, at, at + PAGES_SESSION_TTL_MS))
    return token
  },

  sessionUser: (token: string, host: string): Promise<PagesUser | null> =>
    first<PagesUser>(
      db,
      sql(
        'SELECT a.id AS id, a.login AS login FROM pages_sessions s JOIN accounts a ON a.id = s.user_id WHERE s.token_hash = ? AND s.host = ? AND s.expires_at > ? AND a.disabled_at IS NULL',
        hashOf(token),
        host,
        now(),
      ),
    ),
})

export type PagesStore = ReturnType<typeof createPagesStore>
