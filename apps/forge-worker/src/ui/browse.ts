import {
  type AttributeRule,
  type BlobContent,
  type CommitInfo,
  type DirectoryEntry,
  type LastCommits,
  lastCommitFor,
  lfsAttributeRules,
  type ObjectId,
  readCommit,
  readLastCommits,
  matchesLfs,
  readBlobContent,
  type RefTarget,
  resolveRefAndPath,
  resolveTarget,
} from '@git-forge/core'
import { highlightLines, type HighlightedLine } from './highlight.ts'
import { renderMarkdown } from './markdown.ts'
import { blobUrl, type OpenRepository, rawUrl, reachOf } from './repository.ts'

export type Readme = { readonly name: string; readonly html: string | null; readonly text: string }

export type TreeView = {
  readonly kind: 'tree'
  readonly target: RefTarget
  readonly entries: readonly DirectoryEntry[]
  readonly latest: CommitInfo | null
  readonly commits: ReadonlyMap<string, CommitInfo> | null
  readonly readme: Readme | null
  readonly lfs: ReadonlySet<string>
}

export type BlobView = {
  readonly kind: 'blob'
  readonly target: RefTarget
  readonly entry: DirectoryEntry
  readonly content: BlobContent
  readonly lines: readonly HighlightedLine[] | null
  readonly markdown: string | null
  readonly latest: CommitInfo | null
}

export type BrowseView = TreeView | BlobView | { readonly kind: 'not-found' } | { readonly kind: 'empty' }

const README = /^readme(\.(md|markdown|txt|rst))?$/i

const isMarkdown = (name: string): boolean => /\.(md|markdown|mdx)$/i.test(name)

export const MAX_README_BYTES = 512 * 1024

const directoryOf = (path: readonly string[]): string => path.slice(0, -1).join('/')

const linkBase = (repo: OpenRepository, target: RefTarget, directory: string) => ({
  blob: blobUrl(repo.name, target.ref, []),
  raw: rawUrl(repo.name, target.ref, []),
  directory,
})

const readmeFor = async (repo: OpenRepository, target: RefTarget, entries: readonly DirectoryEntry[]): Promise<Readme | null> => {
  const entry = entries.filter((candidate) => candidate.kind === 'blob' && README.test(candidate.name)).sort((a, b) => Number(isMarkdown(b.name)) - Number(isMarkdown(a.name)))[0]
  if (!entry) return null
  const content = await readBlobContent(repo.odb, entry)
  if (content?.kind !== 'text' || content.size > MAX_README_BYTES) return null
  const html = isMarkdown(entry.name) ? await renderMarkdown(content.text, linkBase(repo, target, target.path.join('/'))) : null
  return { name: entry.name, html, text: content.text }
}

const lfsRules = async (repo: OpenRepository, commit: string, directory: readonly string[]): Promise<AttributeRule[]> => {
  const target = await resolveTarget(repo.odb, commit, [...directory, '.gitattributes'])
  const content = target?.kind === 'blob' ? await readBlobContent(repo.odb, target.entry) : null
  return content?.kind === 'text' ? lfsAttributeRules(content.text, directory.join('/')) : []
}

const lfsEntries = async (repo: OpenRepository, target: RefTarget, entries: readonly DirectoryEntry[]): Promise<Set<string>> => {
  const directories = target.path.map((_, index) => target.path.slice(0, index + 1))
  const rules = (await Promise.all([[], ...directories].map((directory) => lfsRules(repo, target.commit, directory)))).flat()
  if (rules.length === 0) return new Set()
  return new Set(entries.filter((entry) => entry.kind === 'blob' && matchesLfs(rules, [...target.path, entry.name].join('/'))).map((entry) => entry.name))
}

export const MAX_ENTRY_COMMITS = 1000

export const knownLastCommits = async (repo: OpenRepository, commit: ObjectId): Promise<LastCommits | null> =>
  repo.branches.some((branch) => branch.id === commit) ? readLastCommits(repo.odb, commit).catch(() => null) : null

const latestFor = async (repo: OpenRepository, known: Promise<LastCommits | null>, commit: ObjectId, path: readonly string[]): Promise<CommitInfo | null> => {
  const id = path.length === 0 ? commit : (await known)?.get(path.join('/'))
  if (id === undefined) return lastCommitFor(repo.odb, commit, path)
  return id === null ? null : readCommit(repo.odb, id)
}

const entryCommits = async (repo: OpenRepository, known: LastCommits | null, path: readonly string[], names: readonly string[]): Promise<Map<string, CommitInfo> | null> => {
  if (!known || names.length > MAX_ENTRY_COMMITS) return null
  const ids = names.map((name) => [name, known.get([...path, name].join('/')) ?? null] as const)
  const commits = new Map<ObjectId, CommitInfo | null>()
  await Promise.all([...new Set(ids.flatMap(([, id]) => (id ? [id] : [])))].map(async (id) => commits.set(id, await readCommit(repo.odb, id))))
  const result = new Map<string, CommitInfo>()
  for (const [name, id] of ids) {
    const commit = id && commits.get(id)
    if (commit) result.set(name, commit)
  }
  return result
}

export const browse = async (repo: OpenRepository, segments: readonly string[], expect: 'tree' | 'blob' | 'any' = 'any'): Promise<BrowseView> => {
  if (segments.length === 0) {
    if (!repo.defaultBranch) return { kind: 'empty' }
    return browse(repo, [repo.defaultBranch], expect)
  }
  const target = await resolveRefAndPath(repo.odb, repo.refs, segments)
  if (!target) return { kind: 'not-found' }
  const reach = await reachOf(repo, target.commit)
  const here = reach(target.path.join('/'))
  const known = here === 'none' ? Promise.resolve(null) : knownLastCommits(repo, target.commit)
  const pending = here === 'inside' ? latestFor(repo, known, target.commit, target.path) : Promise.resolve(null)
  pending.catch(() => {})
  const resolved = here === 'none' ? null : await resolveTarget(repo.odb, target.commit, target.path)
  if (!resolved || resolved.kind === 'submodule') return { kind: 'not-found' }
  if (resolved.kind === 'tree') {
    if (expect === 'blob') return { kind: 'not-found' }
    const entries = resolved.entries.filter((entry) => reach([...target.path, entry.name].join('/')) !== 'none')
    const visible = entries.filter((entry) => reach([...target.path, entry.name].join('/')) === 'inside').map((entry) => entry.name)
    const [latest, commits, readme, lfs] = await Promise.all([pending, known.then((map) => entryCommits(repo, map, target.path, visible)), readmeFor(repo, target, entries), lfsEntries(repo, target, entries)])
    return { kind: 'tree', target, entries, latest, commits, readme, lfs }
  }
  if (expect === 'tree' || here !== 'inside') return { kind: 'not-found' }
  const [latest, content] = await Promise.all([pending, readBlobContent(repo.odb, resolved.entry)])
  if (!content) return { kind: 'not-found' }
  const markdown =
    content.kind === 'text' && isMarkdown(resolved.entry.name) && content.size <= MAX_README_BYTES
      ? await renderMarkdown(content.text, linkBase(repo, target, directoryOf(target.path)))
      : null
  const lines = content.kind === 'text' ? await highlightLines(content.text, resolved.entry.name) : null
  return { kind: 'blob', target, entry: resolved.entry, content, lines, markdown, latest }
}

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | null

const PREVIEWS: readonly [RegExp, Exclude<PreviewKind, null>][] = [
  [/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i, 'image'],
  [/\.(mp4|webm|mov|m4v|ogv)$/i, 'video'],
  [/\.(mp3|wav|ogg|oga|flac|m4a|aac|opus)$/i, 'audio'],
  [/\.pdf$/i, 'pdf'],
]

export const previewKind = (filename: string): PreviewKind => PREVIEWS.find(([pattern]) => pattern.test(filename))?.[1] ?? null
