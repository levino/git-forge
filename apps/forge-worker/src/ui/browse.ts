import {
  type BlobContent,
  type CommitInfo,
  type DirectoryEntry,
  lastCommitFor,
  readBlobContent,
  type RefTarget,
  resolveRefAndPath,
  resolveTarget,
} from '@git-forge/core'
import { highlightLines, type HighlightedLine } from './highlight.ts'
import { renderMarkdown } from './markdown.ts'
import { blobUrl, type OpenRepository, rawUrl } from './repository.ts'

export type Readme = { readonly name: string; readonly html: string | null; readonly text: string }

export type TreeView = {
  readonly kind: 'tree'
  readonly target: RefTarget
  readonly entries: readonly DirectoryEntry[]
  readonly latest: CommitInfo | null
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

const globPattern = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?|\*|\?/g, (token) => (token === '?' ? '[^/]' : token === '*' ? '[^/]*' : '.*'))}$`)

const lfsPatterns = async (repo: OpenRepository, commit: string, directory: readonly string[]): Promise<{ readonly base: string; readonly pattern: RegExp; readonly anchored: boolean }[]> => {
  const target = await resolveTarget(repo.odb, commit, [...directory, '.gitattributes'])
  const content = target?.kind === 'blob' ? await readBlobContent(repo.odb, target.entry) : null
  if (content?.kind !== 'text') return []
  return content.text
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([glob, ...attributes]) => glob && !glob.startsWith('#') && attributes.includes('filter=lfs'))
    .map(([glob]) => ({ base: directory.join('/'), pattern: globPattern(glob!.replace(/^\//, '')), anchored: glob!.includes('/') }))
}

const lfsEntries = async (repo: OpenRepository, target: RefTarget, entries: readonly DirectoryEntry[]): Promise<Set<string>> => {
  const directories = target.path.map((_, index) => target.path.slice(0, index + 1))
  const patterns = (await Promise.all([[], ...directories].map((directory) => lfsPatterns(repo, target.commit, directory)))).flat()
  if (patterns.length === 0) return new Set()
  const path = target.path.join('/')
  return new Set(
    entries
      .filter((entry) => entry.kind === 'blob')
      .filter((entry) =>
        patterns.some(({ base, pattern, anchored }) => {
          const full = [path, entry.name].filter(Boolean).join('/')
          const relative = base === '' ? full : full.slice(base.length + 1)
          return anchored ? pattern.test(relative) : pattern.test(entry.name)
        }),
      )
      .map((entry) => entry.name),
  )
}

export const browse = async (repo: OpenRepository, segments: readonly string[], expect: 'tree' | 'blob' | 'any' = 'any'): Promise<BrowseView> => {
  if (segments.length === 0) {
    if (!repo.defaultBranch) return { kind: 'empty' }
    return browse(repo, [repo.defaultBranch], expect)
  }
  const target = await resolveRefAndPath(repo.odb, repo.refs, segments)
  if (!target) return { kind: 'not-found' }
  const resolved = await resolveTarget(repo.odb, target.commit, target.path)
  if (!resolved || resolved.kind === 'submodule') return { kind: 'not-found' }
  const latest = await lastCommitFor(repo.odb, target.commit, target.path)
  if (resolved.kind === 'tree') {
    if (expect === 'blob') return { kind: 'not-found' }
    const [readme, lfs] = await Promise.all([readmeFor(repo, target, resolved.entries), lfsEntries(repo, target, resolved.entries)])
    return { kind: 'tree', target, entries: resolved.entries, latest, readme, lfs }
  }
  if (expect === 'tree') return { kind: 'not-found' }
  const content = await readBlobContent(repo.odb, resolved.entry)
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
