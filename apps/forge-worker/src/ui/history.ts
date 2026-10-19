import {
  blame,
  type BlameRange,
  type CommitInfo,
  DEFAULT_BLAME_COMMITS,
  readBlobContent,
  resolveTarget,
  commitChanges,
  commitLog,
  diffFile,
  type FileDiff,
  isObjectId,
  readCommit,
  type RefTarget,
  resolveRefAndPath,
} from '@git-forge/core'
import { knownLastCommits } from './browse.ts'
import { type HighlightedLine, highlightLines } from './highlight.ts'
import { type OpenRepository, reachOf } from './repository.ts'

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
  if (!target || (await reachOf(repo, target.commit))(target.path.join('/')) !== 'inside') return { kind: 'not-found' }
  const first = target.path.length > 0 ? (await knownLastCommits(repo, target.commit))?.get(target.path.join('/')) : undefined
  const log = await commitLog(repo.odb, target.commit, { limit: COMMITS_PER_PAGE, skip: (page - 1) * COMMITS_PER_PAGE, path: target.path, ...(first !== undefined ? { first } : {}) })
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
  const reach = await reachOf(repo, commit.id)
  const changes = (await commitChanges(repo.odb, commit)).filter((change) => reach(change.path) === 'inside' && (change.previousPath === null || reach(change.previousPath) === 'inside'))
  if (reach('') !== 'inside' && changes.length === 0) return { kind: 'not-found' }
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

export type BlameView =
  | { readonly kind: 'blame'; readonly target: RefTarget; readonly ranges: readonly BlameRange[]; readonly lines: readonly HighlightedLine[]; readonly more: boolean; readonly depth: number }
  | { readonly kind: 'not-found' }

export const MAX_BLAME_DEPTH = 20

export const blameView = async (repo: OpenRepository, segments: readonly string[], depth: number): Promise<BlameView> => {
  const target = await resolveRefAndPath(repo.odb, repo.refs, segments)
  const resolved = target && (await reachOf(repo, target.commit))(target.path.join('/')) === 'inside' ? await resolveTarget(repo.odb, target.commit, target.path) : null
  const content = resolved?.kind === 'blob' ? await readBlobContent(repo.odb, resolved.entry) : null
  if (!target || resolved?.kind !== 'blob' || content?.kind !== 'text') return { kind: 'not-found' }
  const bounded = Math.min(depth, MAX_BLAME_DEPTH)
  const result = await blame(repo.odb, target.commit, target.path, bounded * DEFAULT_BLAME_COMMITS)
  if (!result) return { kind: 'not-found' }
  return { kind: 'blame', target, ranges: result.ranges, lines: await highlightLines(content.text, resolved.entry.name), more: !result.complete && bounded < MAX_BLAME_DEPTH, depth: bounded }
}
