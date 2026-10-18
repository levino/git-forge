import { type Database, first, sql } from '@git-forge/accounts'

export type ReleaseRow = {
  readonly id: number
  readonly repository_id: string
  readonly tag_name: string
  readonly target_commitish: string
  readonly name: string | null
  readonly body: string | null
  readonly draft: number
  readonly prerelease: number
  readonly author_kind: string
  readonly author_id: string | null
  readonly author_login: string | null
  readonly created_at: number
  readonly updated_at: number
  readonly published_at: number | null
}

export type AssetRow = {
  readonly id: number
  readonly release_id: number
  readonly name: string
  readonly label: string | null
  readonly content_type: string
  readonly size: number
  readonly oid: string
  readonly download_count: number
  readonly uploader_kind: string
  readonly uploader_id: string | null
  readonly uploader_login: string | null
  readonly created_at: number
  readonly updated_at: number
}

export type Author = { readonly kind: string; readonly id: string | null; readonly login: string | null }

export type ReleaseInput = {
  readonly tagName: string
  readonly targetCommitish: string
  readonly name: string | null
  readonly body: string | null
  readonly draft: boolean
  readonly prerelease: boolean
}

export class ReleaseConflictError extends Error {}

const isUniqueViolation = (error: unknown): boolean => /UNIQUE constraint failed/i.test(String((error as Error)?.message ?? error))

export const createReleaseStore = (db: Database, now: () => number = Date.now) => ({
  list: (repositoryId: string, includeDrafts: boolean, limit: number, offset: number): Promise<ReleaseRow[]> =>
    db.all<ReleaseRow>(
      sql(
        `SELECT * FROM releases WHERE repository_id = ? ${includeDrafts ? '' : 'AND draft = 0'} ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`,
        repositoryId,
        limit,
        offset,
      ),
    ),

  get: (repositoryId: string, id: number): Promise<ReleaseRow | null> => first<ReleaseRow>(db, sql('SELECT * FROM releases WHERE repository_id = ? AND id = ?', repositoryId, id)),

  byTag: (repositoryId: string, tag: string): Promise<ReleaseRow | null> => first<ReleaseRow>(db, sql('SELECT * FROM releases WHERE repository_id = ? AND tag_name = ?', repositoryId, tag)),

  latest: (repositoryId: string): Promise<ReleaseRow | null> =>
    first<ReleaseRow>(db, sql('SELECT * FROM releases WHERE repository_id = ? AND draft = 0 AND prerelease = 0 ORDER BY published_at DESC, id DESC LIMIT 1', repositoryId)),

  create: async (repositoryId: string, input: ReleaseInput, author: Author): Promise<ReleaseRow> => {
    const at = now()
    try {
      const rows = await db.all<ReleaseRow>(
        sql(
          `INSERT INTO releases (repository_id, tag_name, target_commitish, name, body, draft, prerelease, author_kind, author_id, author_login, created_at, updated_at, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          repositoryId,
          input.tagName,
          input.targetCommitish,
          input.name,
          input.body,
          input.draft ? 1 : 0,
          input.prerelease ? 1 : 0,
          author.kind,
          author.id,
          author.login,
          at,
          at,
          input.draft ? null : at,
        ),
      )
      return rows[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw new ReleaseConflictError(`a release for tag ${input.tagName} already exists`)
      throw error
    }
  },

  update: async (release: ReleaseRow, input: ReleaseInput): Promise<ReleaseRow> => {
    const at = now()
    try {
      const rows = await db.all<ReleaseRow>(
        sql(
          `UPDATE releases SET tag_name = ?, target_commitish = ?, name = ?, body = ?, draft = ?, prerelease = ?, updated_at = ?, published_at = ? WHERE id = ? RETURNING *`,
          input.tagName,
          input.targetCommitish,
          input.name,
          input.body,
          input.draft ? 1 : 0,
          input.prerelease ? 1 : 0,
          at,
          input.draft ? null : (release.published_at ?? at),
          release.id,
        ),
      )
      return rows[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw new ReleaseConflictError(`a release for tag ${input.tagName} already exists`)
      throw error
    }
  },

  delete: async (id: number): Promise<void> => {
    await db.batch([sql('DELETE FROM release_assets WHERE release_id = ?', id), sql('DELETE FROM releases WHERE id = ?', id)])
  },

  assets: (releaseIds: readonly number[]): Promise<AssetRow[]> =>
    releaseIds.length === 0
      ? Promise.resolve([])
      : db.all<AssetRow>(sql(`SELECT * FROM release_assets WHERE release_id IN (${releaseIds.map(() => '?').join(', ')}) ORDER BY id`, ...releaseIds)),

  asset: (repositoryId: string, id: number): Promise<(AssetRow & { readonly tag_name: string; readonly draft: number }) | null> =>
    first<AssetRow & { tag_name: string; draft: number }>(
      db,
      sql('SELECT a.*, r.tag_name, r.draft FROM release_assets a JOIN releases r ON r.id = a.release_id WHERE r.repository_id = ? AND a.id = ?', repositoryId, id),
    ),

  assetByName: (releaseId: number, name: string): Promise<AssetRow | null> => first<AssetRow>(db, sql('SELECT * FROM release_assets WHERE release_id = ? AND name = ?', releaseId, name)),

  addAsset: async (
    releaseId: number,
    input: { readonly name: string; readonly label: string | null; readonly contentType: string; readonly size: number; readonly oid: string },
    uploader: Author,
  ): Promise<AssetRow> => {
    const at = now()
    try {
      const rows = await db.all<AssetRow>(
        sql(
          `INSERT INTO release_assets (release_id, name, label, content_type, size, oid, uploader_kind, uploader_id, uploader_login, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          releaseId,
          input.name,
          input.label,
          input.contentType,
          input.size,
          input.oid,
          uploader.kind,
          uploader.id,
          uploader.login,
          at,
          at,
        ),
      )
      return rows[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw new ReleaseConflictError(`an asset named ${input.name} already exists`)
      throw error
    }
  },

  updateAsset: async (id: number, name: string, label: string | null): Promise<void> => {
    try {
      await db.run(sql('UPDATE release_assets SET name = ?, label = ?, updated_at = ? WHERE id = ?', name, label, now(), id))
    } catch (error) {
      if (isUniqueViolation(error)) throw new ReleaseConflictError(`an asset named ${name} already exists`)
      throw error
    }
  },

  deleteAsset: async (id: number): Promise<void> => {
    await db.run(sql('DELETE FROM release_assets WHERE id = ?', id))
  },

  countDownload: async (id: number): Promise<void> => {
    await db.run(sql('UPDATE release_assets SET download_count = download_count + 1 WHERE id = ?', id))
  },
})

export type ReleaseStore = ReturnType<typeof createReleaseStore>
