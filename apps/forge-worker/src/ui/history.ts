import {
  type CommitInfo,
  commitChanges,
  commitLog,
  diffFile,
  type FileDiff,
  isObjectId,
  readCommit,
  type RefTarget,
  resolveRefAndPath,
} from '@git-forge/core'
import type { OpenRepository } from './repository.ts'

export const COMMITS_PER_PAGE = 30

export const MAX_DIFF_FILES = 300

export const MAX_DIFF_BLOB_BYTES = 512 * 1024

export type HistoryView =
  | { readonly kind: 'history'; readonly target: RefTarget; readonly commits: readonly CommitInfo[]; readonly page: number; readonly more: boolean }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'empty' }

export const parsePage = (value: string | null): number => {
  const page = Number(value ?? '1')
  return Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1
}

export const history = async (repo: OpenRepository, segments: readonly string[], page: number): Promise<HistoryView> => {
  if (segments.length === 0) return repo.defaultBranch ? history(repo, [repo.defaultBranch], page) : { kind: 'empty' }
  const target = await resolveRefAndPath(repo.odb, repo.refs, segments)
  if (!target) return { kind: 'not-found' }
  const log = await commitLog(repo.odb, target.commit, { limit: COMMITS_PER_PAGE, skip: (page - 1) * COMMITS_PER_PAGE, path: target.path })
  return { kind: 'history', target, commits: log.commits, page, more: log.more }
}

export type CommitView = {
  readonly kind: 'commit'
  readonly commit: CommitInfo
  readonly files: readonly FileDiff[]
  readonly truncated: boolean
  readonly added: number
  readonly deleted: number
}

export const commitView = async (repo: OpenRepository, id: string): Promise<CommitView | { readonly kind: 'not-found' }> => {
  if (!isObjectId(id)) return { kind: 'not-found' }
  const commit = await readCommit(repo.odb, id)
  if (!commit) return { kind: 'not-found' }
  const changes = await commitChanges(repo.odb, commit)
  const shown = changes.slice(0, MAX_DIFF_FILES)
  const files: FileDiff[] = []
  let added = 0
  let deleted = 0
  for (const change of shown) {
    const file = await diffFile(repo.odb, change, { maxBlobBytes: MAX_DIFF_BLOB_BYTES })
    added += file.additions
    deleted += file.deletions
    files.push(file)
  }
  return { kind: 'commit', commit, files, truncated: changes.length > shown.length, added, deleted }
}
