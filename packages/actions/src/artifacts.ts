import { type Database, first, sql } from '@git-forge/accounts'
import { repositoryPrefix } from '@git-forge/core'
import { type BlobRow, createBlob } from './blobs.ts'

export type ArtifactRow = {
  readonly id: number
  readonly owner: string
  readonly repo: string
  readonly run_id: number
  readonly job_id: string
  readonly name: string
  readonly blob_id: string
  readonly version: number
  readonly mime_type: string | null
  readonly size: number | null
  readonly digest: string | null
  readonly created_at: number
  readonly finalized_at: number | null
  readonly expires_at: number
  readonly deleted_at: number | null
}

export const DEFAULT_ARTIFACT_RETENTION_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

export const MAX_ARTIFACT_NAME_LENGTH = 256

const INVALID_NAME_CHARACTERS = /["':<>|*?\r\n\\/]/

export const validArtifactName = (name: string): boolean => name.trim().length > 0 && name.length <= MAX_ARTIFACT_NAME_LENGTH && !INVALID_NAME_CHARACTERS.test(name)

export const artifactExpiry = (createdAt: number, requested: number | null, retentionDays: number): number => {
  const max = createdAt + retentionDays * DAY_MS
  if (requested === null || !Number.isFinite(requested) || requested <= createdAt) return max
  return Math.min(requested, max)
}

export const artifactFilename = (artifact: Pick<ArtifactRow, 'name' | 'mime_type' | 'version'>): string =>
  artifact.mime_type === null || artifact.mime_type === 'application/zip' ? `${artifact.name}.zip` : artifact.name

export const artifactPrefix = (owner: string, repo: string): string => `${repositoryPrefix({ owner, name: repo })}actions/artifacts/`

export type NewArtifact = {
  readonly owner: string
  readonly repo: string
  readonly runId: number
  readonly jobId: string
  readonly name: string
  readonly version: number
  readonly mimeType: string | null
  readonly expiresAt: number
}

export const createArtifact = async (db: Database, artifact: NewArtifact, now: number): Promise<{ readonly artifact: ArtifactRow; readonly blob: BlobRow } | null> => {
  const blob = await createBlob(db, { owner: artifact.owner, repo: artifact.repo, prefix: artifactPrefix(artifact.owner, artifact.repo), contentType: artifact.mimeType ?? 'application/zip' }, now)
  try {
    const [row] = await db.all<ArtifactRow>(
      sql(
        'INSERT INTO actions_artifacts (owner, repo, run_id, job_id, name, blob_id, version, mime_type, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
        artifact.owner,
        artifact.repo,
        artifact.runId,
        artifact.jobId,
        artifact.name,
        blob.id,
        artifact.version,
        artifact.mimeType,
        now,
        artifact.expiresAt,
      ),
    )
    return { artifact: row!, blob }
  } catch (error) {
    if (/UNIQUE|constraint/i.test(String((error as Error)?.message ?? error))) return null
    throw error
  }
}

export const getArtifact = async (db: Database, id: number): Promise<ArtifactRow | null> => first<ArtifactRow>(db, sql('SELECT * FROM actions_artifacts WHERE id = ?', id))

export const artifactByName = async (db: Database, runId: number, name: string): Promise<ArtifactRow | null> =>
  first<ArtifactRow>(db, sql('SELECT * FROM actions_artifacts WHERE run_id = ? AND name = ? AND deleted_at IS NULL', runId, name))

export const finalizeArtifact = async (db: Database, artifact: ArtifactRow, size: number, digest: string | null, now: number): Promise<boolean> =>
  (await db.run(sql('UPDATE actions_artifacts SET size = ?, digest = ?, finalized_at = ? WHERE id = ? AND finalized_at IS NULL AND deleted_at IS NULL', size, digest, now, artifact.id))).changes === 1

export const deleteArtifact = async (db: Database, id: number, now: number): Promise<boolean> =>
  (await db.run(sql('UPDATE actions_artifacts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', now, id))).changes === 1

export type ArtifactFilter = {
  readonly runId?: number
  readonly name?: string
  readonly id?: number
  readonly includeExpired?: boolean
}

export const listArtifacts = async (db: Database, owner: string, repo: string, filter: ArtifactFilter, now: number, limit = 100): Promise<ArtifactRow[]> =>
  db.all<ArtifactRow>(
    sql(
      'SELECT * FROM actions_artifacts WHERE owner = ? AND repo = ? AND deleted_at IS NULL AND finalized_at IS NOT NULL AND (? IS NULL OR run_id = ?) AND (? IS NULL OR name = ?) AND (? IS NULL OR id = ?) AND (? = 1 OR expires_at > ?) ORDER BY id DESC LIMIT ?',
      owner,
      repo,
      filter.runId ?? null,
      filter.runId ?? null,
      filter.name ?? null,
      filter.name ?? null,
      filter.id ?? null,
      filter.id ?? null,
      filter.includeExpired ? 1 : 0,
      now,
      limit,
    ),
  )
