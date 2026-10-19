import { concat, fromUtf8, utf8 } from './bytes.ts'
import { entryAt } from './browse.ts'
import { serializeCommit, serializeTree, StagedObjects } from './commit.ts'
import type { ObjectId } from './hash.ts'
import { LFS_POINTER_VERSION, type LfsObjectSpec, parseLfsPointer } from './lfs.ts'
import { type ConflictReason, mergeCommitTrees, reachableObjects } from './merge.ts'
import { type GitObject, isSubmodule, isTreeMode, parseCommit, parseTree, type Signature, type TreeEntry } from './objects.ts'
import type { ObjectSource } from './walk.ts'
import { conflictLines, splitLines } from './xdiff.ts'

export class EditError extends Error {}

export const MAX_WEB_FILE_BYTES = 10 * 1024 * 1024

export type FileChange = { readonly path: string; readonly content: Uint8Array | null; readonly mode?: string }

export type NewObjects = { readonly commit: ObjectId; readonly tree: ObjectId; readonly objects: readonly (GitObject & { readonly id: ObjectId })[] }

export const normalizePath = (path: string): string => {
  const segments = path.split('/').filter((segment) => segment !== '')
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..' || segment.toLowerCase() === '.git' || /[\0\n\r]/.test(segment))) {
    throw new EditError(`invalid path: ${path}`)
  }
  return segments.join('/')
}

const readTree = async (source: ObjectSource, id: ObjectId | null): Promise<TreeEntry[]> => {
  if (id === null) return []
  const object = await source.read(id)
  if (object?.type !== 'tree') throw new EditError(`missing tree ${id}`)
  return parseTree(object.data)
}

type Pending = { readonly segments: readonly string[]; readonly change: FileChange }

const rewrite = async (staged: StagedObjects, tree: ObjectId | null, pending: readonly Pending[], prefix: string): Promise<ObjectId | null> => {
  const entries = new Map((await readTree(staged, tree)).map((entry) => [entry.name, entry]))
  const groups = new Map<string, Pending[]>()
  for (const item of pending) groups.set(item.segments[0]!, [...(groups.get(item.segments[0]!) ?? []), item])
  for (const [name, group] of groups) {
    const path = `${prefix}${name}`
    const existing = entries.get(name)
    const leaf = group.find((item) => item.segments.length === 1)
    if (leaf) {
      if (group.length > 1) throw new EditError(`${path} is changed twice`)
      if (existing && (isTreeMode(existing.mode) || isSubmodule(existing))) throw new EditError(`${path} is a directory`)
      if (leaf.change.content === null) {
        if (!existing) throw new EditError(`${path} does not exist`)
        entries.delete(name)
      } else entries.set(name, { mode: leaf.change.mode ?? existing?.mode ?? '100644', name, id: staged.add('blob', leaf.change.content) })
      continue
    }
    if (existing && !isTreeMode(existing.mode)) throw new EditError(`${path} is a file`)
    const child = await rewrite(staged, existing?.id ?? null, group.map((item) => ({ segments: item.segments.slice(1), change: item.change })), `${path}/`)
    if (child === null) entries.delete(name)
    else entries.set(name, { mode: '40000', name, id: child })
  }
  return entries.size === 0 ? null : staged.add('tree', serializeTree([...entries.values()]))
}

export const treeOfCommit = async (source: ObjectSource, commit: ObjectId | null): Promise<ObjectId | null> => {
  if (commit === null) return null
  const object = await source.read(commit)
  if (object?.type !== 'commit') throw new EditError(`missing commit ${commit}`)
  return parseCommit(object.data).tree
}

export const applyFileChanges = async (staged: StagedObjects, tree: ObjectId | null, changes: readonly FileChange[]): Promise<ObjectId> =>
  (await rewrite(staged, tree, changes.map((change) => ({ segments: normalizePath(change.path).split('/'), change })), '')) ?? staged.add('tree', new Uint8Array(0))

export type CommitRequest = {
  readonly parent: ObjectId | null
  readonly changes: readonly FileChange[]
  readonly message: string
  readonly author: Signature
  readonly committer: Signature
}

export const commitFileChanges = async (source: ObjectSource, request: CommitRequest): Promise<NewObjects> => {
  if (request.message.trim() === '') throw new EditError('commit message is required')
  const staged = new StagedObjects(source)
  const before = await treeOfCommit(staged, request.parent)
  const tree = await applyFileChanges(staged, before, request.changes)
  if (tree === before) throw new EditError('no changes to commit')
  const commit = staged.add('commit', serializeCommit({ tree, parents: request.parent ? [request.parent] : [], author: request.author, committer: request.committer, message: request.message }))
  return { commit, tree, objects: reachableObjects(staged, commit) }
}

export const fileAt = async (source: ObjectSource, commit: ObjectId | null, path: string): Promise<TreeEntry | null> => {
  const tree = await treeOfCommit(source, commit)
  const entry = tree === null ? null : await entryAt(source, tree, normalizePath(path).split('/'))
  return entry && !isTreeMode(entry.mode) ? entry : null
}

const globSource = (glob: string): string =>
  glob.replace(/\*\*\/|\/\*\*$|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (token) =>
    token === '**/' ? '(?:.*/)?' : token === '/**' ? '/.*' : token === '**' ? '.*' : token === '*' ? '[^/]*' : token === '?' ? '[^/]' : `\\${token}`,
  )

export type AttributeRule = { readonly base: string; readonly pattern: RegExp; readonly anchored: boolean; readonly lfs: boolean }

export const lfsAttributeRules = (text: string, base: string): AttributeRule[] =>
  text.split('\n').flatMap((line) => {
    const [glob, ...attributes] = line.trim().split(/\s+/)
    if (!glob || glob.startsWith('#') || glob.startsWith('!')) return []
    const filter = attributes.findLast((attribute) => /^[-!]?filter(=|$)/.test(attribute))
    if (filter === undefined) return []
    const trimmed = glob.replace(/\/$/, '')
    return [{ base, pattern: new RegExp(`^${globSource(trimmed.replace(/^\//, ''))}$`), anchored: trimmed.includes('/'), lfs: filter === 'filter=lfs' }]
  })

export const matchesLfs = (rules: readonly AttributeRule[], path: string): boolean => {
  let lfs = false
  for (const rule of rules) {
    if (rule.base !== '' && !path.startsWith(`${rule.base}/`)) continue
    const relative = rule.base === '' ? path : path.slice(rule.base.length + 1)
    if (rule.anchored ? rule.pattern.test(relative) : rule.pattern.test(relative.slice(relative.lastIndexOf('/') + 1))) lfs = rule.lfs
  }
  return lfs
}

export const isLfsTracked = async (source: ObjectSource, commit: ObjectId | null, path: string): Promise<boolean> => {
  const segments = normalizePath(path).split('/')
  const rules: AttributeRule[] = []
  for (let depth = 0; depth < segments.length; depth++) {
    const base = segments.slice(0, depth).join('/')
    const entry = await fileAt(source, commit, base === '' ? '.gitattributes' : `${base}/.gitattributes`)
    const object = entry ? await source.read(entry.id) : null
    if (object?.type === 'blob') rules.push(...lfsAttributeRules(fromUtf8(object.data), base))
  }
  return matchesLfs(rules, segments.join('/'))
}

export const lfsPointerText = (object: LfsObjectSpec): Uint8Array => utf8(`version ${LFS_POINTER_VERSION}\noid sha256:${object.oid}\nsize ${object.size}\n`)

export type ConflictFile = { readonly path: string; readonly reason: ConflictReason; readonly text: string | null }

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const editableText = (data: Uint8Array): string | null => {
  if (data.length > MAX_WEB_FILE_BYTES || parseLfsPointer(data)) return null
  try {
    return strictUtf8.decode(data)
  } catch {
    return null
  }
}

const blobData = async (source: ObjectSource, id: ObjectId | null): Promise<Uint8Array> => {
  if (id === null) return new Uint8Array(0)
  const object = await source.read(id)
  if (object?.type !== 'blob') throw new EditError(`missing blob ${id}`)
  return object.data
}

export const mergeConflictFiles = async (source: ObjectSource, ours: ObjectId, theirs: ObjectId, labels: readonly [string, string]): Promise<ConflictFile[] | null> => {
  const staged = new StagedObjects(source)
  const merged = await mergeCommitTrees(staged, ours, theirs)
  if (merged.ok) return []
  if (merged.reason === 'unrelated') return null
  return Promise.all(
    merged.conflicts.map(async (conflict) => {
      const sides = conflict.reason === 'content' ? merged.sides?.get(conflict.path) : undefined
      if (!sides) return { ...conflict, text: null }
      const [base, mine, other] = await Promise.all([blobData(staged, sides.base), blobData(staged, sides.ours), blobData(staged, sides.theirs)])
      if ([base, mine, other].some((data) => editableText(data) === null)) return { ...conflict, text: null }
      return { ...conflict, text: editableText(concat(conflictLines(splitLines(base), splitLines(mine), splitLines(other), labels))) }
    }),
  )
}

const MARKER = /^(<<<<<<<|>>>>>>>)( |$)/m

export type ResolveRequest = {
  readonly ours: ObjectId
  readonly theirs: ObjectId
  readonly resolutions: ReadonlyMap<string, string>
  readonly message: string
  readonly author: Signature
  readonly committer: Signature
}

export const resolveMergeConflicts = async (source: ObjectSource, request: ResolveRequest): Promise<NewObjects> => {
  const files = await mergeConflictFiles(source, request.ours, request.theirs, ['ours', 'theirs'])
  if (files === null) throw new EditError('the branches have no history in common')
  if (files.length === 0) throw new EditError('the branches merge without conflicts')
  const blocked = files.filter((file) => file.text === null)
  if (blocked.length > 0) throw new EditError(`cannot resolve ${blocked.map((file) => `${file.path} (${file.reason})`).join(', ')} in the browser; resolve them with git`)
  const resolutions = new Map<string, Uint8Array>()
  for (const file of files) {
    const text = request.resolutions.get(file.path)
    if (text === undefined) throw new EditError(`${file.path} is not resolved`)
    if (MARKER.test(text)) throw new EditError(`${file.path} still contains conflict markers`)
    resolutions.set(file.path, utf8(text))
  }
  const staged = new StagedObjects(source)
  const merged = await mergeCommitTrees(staged, request.ours, request.theirs, 0, resolutions)
  if (!merged.ok) throw new EditError('the merge still has conflicts')
  const commit = staged.add('commit', serializeCommit({ tree: merged.tree, parents: [request.ours, request.theirs], author: request.author, committer: request.committer, message: request.message }))
  return { commit, tree: merged.tree, objects: reachableObjects(staged, commit) }
}
