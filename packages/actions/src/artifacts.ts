import { type Database, first, sql } from '@git-forge/accounts'
import { fromUtf8, readAll, repositoryPrefix, type Storage } from '@git-forge/core'
import { type BlobRow, createBlob, getBlob, openBlob } from './blobs.ts'

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

const u16 = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8)

const u32 = (bytes: Uint8Array, at: number): number => u16(bytes, at) + u16(bytes, at + 2) * 0x10000

const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024

export const PAGES_ARCHIVE = 'artifact.tar'

export const openArtifactFile = async (db: Database, storage: Storage, owner: string, repo: string, id: number, now: number): Promise<ReadableStream<Uint8Array> | null> => {
  const artifact = await getArtifact(db, id)
  if (!artifact || artifact.owner !== owner || artifact.repo !== repo || artifact.finalized_at === null || artifact.deleted_at !== null || artifact.expires_at <= now) return null
  const blob = await getBlob(db, artifact.blob_id)
  if (!blob?.size) return null
  if (artifact.mime_type !== null && artifact.mime_type !== 'application/zip') return openBlob(db, storage, blob)
  const range = (offset: number, length: number) => readAll(openBlob(db, storage, blob, { offset, length }), MAX_DIRECTORY_BYTES)
  const tail = await range(Math.max(0, blob.size - 22 - 0xffff), Math.min(blob.size, 22 + 0xffff))
  let end = tail.length - 22
  while (end >= 0 && u32(tail, end) !== 0x06054b50) end--
  if (end < 0 || u32(tail, end + 12) > MAX_DIRECTORY_BYTES) return null
  const directory = await range(u32(tail, end + 16), u32(tail, end + 12))
  const entries: { readonly name: string; readonly method: number; readonly size: number; readonly offset: number }[] = []
  for (let at = 0; at + 46 <= directory.length && u32(directory, at) === 0x02014b50; at += 46 + u16(directory, at + 28) + u16(directory, at + 30) + u16(directory, at + 32)) {
    entries.push({ name: fromUtf8(directory.subarray(at + 46, at + 46 + u16(directory, at + 28))), method: u16(directory, at + 10), size: u32(directory, at + 20), offset: u32(directory, at + 42) })
  }
  const entry = entries.find((candidate) => candidate.name === PAGES_ARCHIVE) ?? (entries.length === 1 ? entries[0] : undefined)
  if (!entry || (entry.method !== 0 && entry.method !== 8) || entry.size === 0xffffffff || entry.offset === 0xffffffff) return null
  const local = await range(entry.offset, 30)
  const data = openBlob(db, storage, blob, { offset: entry.offset + 30 + u16(local, 26) + u16(local, 28), length: entry.size })
  return entry.method === 8 ? data.pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>) : data
}
