import { diffTrees } from './diff.ts'
import type { ObjectId } from './hash.ts'
import { parseLfsPointer } from './lfs.ts'
import { isSubmodule, isTreeMode, parseCommit, parseTag, parseTree } from './objects.ts'
import type { RefCommand } from './receive-pack.ts'
import { MissingObjectError, type ObjectSource } from './walk.ts'

export type PathRule = {
  readonly id: string
  readonly pattern: string
}

const escape = (char: string): string => (/[\\^$.|+(){}[\]]/.test(char) ? `\\${char}` : char)

export const isValidPathPattern = (pattern: string): boolean =>
  pattern.length > 0 && pattern.length <= 500 && !pattern.startsWith('/') && !pattern.split('/').some((part) => part === '..' || part === '.') && !/[\x00-\x1f\\]/.test(pattern)

export const compilePathPattern = (pattern: string): RegExp => {
  if (!isValidPathPattern(pattern.replace(/\/$/, '') || 'x')) throw new Error(`invalid path pattern ${pattern}`)
  const directory = pattern.endsWith('/')
  const body = directory ? pattern.slice(0, -1) : pattern
  let source = ''
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char === '*' && body[i + 1] === '*') {
      const slash = body[i + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += escape(char)
  }
  return new RegExp(`^${source}${directory ? '/.*' : '(?:/.*)?'}$`)
}

export type PathMatcher = (path: string) => PathRule | null

export const pathMatcher = (rules: readonly PathRule[]): PathMatcher => {
  const compiled = rules.map((rule) => ({ rule, regex: compilePathPattern(rule.pattern) }))
  return (path) => compiled.find((entry) => entry.regex.test(path))?.rule ?? null
}

export type RestrictedPointer = {
  readonly oid: string
  readonly size: number
  readonly path: string
  readonly rule: string
  readonly commit: ObjectId
}

export type RestrictedViolation = {
  readonly path: string
  readonly rule: string
  readonly commit: ObjectId
  readonly reason: 'not-an-lfs-pointer' | 'not-a-file'
}

export type RestrictedScan = {
  readonly pointers: readonly RestrictedPointer[]
  readonly violations: readonly RestrictedViolation[]
}

const read = async (source: ObjectSource, id: ObjectId) => {
  const object = await source.read(id)
  if (!object) throw new MissingObjectError(id)
  return object
}

const peelToCommit = async (source: ObjectSource, id: ObjectId): Promise<ObjectId | null> => {
  let current = id
  for (let depth = 0; depth < 10; depth++) {
    const object = await read(source, current)
    if (object.type === 'commit') return current
    if (object.type !== 'tag') return null
    current = parseTag(object.data).object
  }
  return null
}

const inspectEntry = async (
  source: ObjectSource,
  match: PathMatcher,
  path: string,
  mode: string,
  id: ObjectId,
  commit: ObjectId,
  out: { pointers: RestrictedPointer[]; violations: RestrictedViolation[] },
) => {
  const rule = match(path)
  if (!rule) return
  if (mode === '120000' || isSubmodule({ mode, name: '', id })) {
    out.violations.push({ path, rule: rule.id, commit, reason: 'not-a-file' })
    return
  }
  const pointer = parseLfsPointer((await read(source, id)).data)
  if (pointer) out.pointers.push({ ...pointer, path, rule: rule.id, commit })
  else out.violations.push({ path, rule: rule.id, commit, reason: 'not-an-lfs-pointer' })
}

export const scanNewCommits = async (
  source: ObjectSource,
  isNew: (id: ObjectId) => boolean,
  tips: readonly ObjectId[],
  match: PathMatcher,
): Promise<RestrictedScan> => {
  const out = { pointers: [] as RestrictedPointer[], violations: [] as RestrictedViolation[] }
  const seen = new Set<ObjectId>()
  const queue: ObjectId[] = []
  for (const tip of tips) {
    const commit = await peelToCommit(source, tip)
    if (commit) queue.push(commit)
  }
  while (queue.length > 0) {
    const id = queue.pop()!
    if (seen.has(id) || !isNew(id)) continue
    seen.add(id)
    const commit = parseCommit((await read(source, id)).data)
    const parent = commit.parents[0]
    const parentTree = parent ? parseCommit((await read(source, parent)).data).tree : null
    for (const change of await diffTrees(source, parentTree, commit.tree, { renames: false })) {
      if (change.newId === null || change.newMode === null) continue
      await inspectEntry(source, match, change.path, change.newMode, change.newId, id, out)
    }
    queue.push(...commit.parents)
  }
  return out
}

export const scanTree = async (source: ObjectSource, commitId: ObjectId, match: PathMatcher): Promise<RestrictedScan> => {
  const out = { pointers: [] as RestrictedPointer[], violations: [] as RestrictedViolation[] }
  const commit = await peelToCommit(source, commitId)
  if (!commit) return out
  const walk = async (tree: ObjectId, prefix: string): Promise<void> => {
    for (const entry of parseTree((await read(source, tree)).data)) {
      const path = `${prefix}${entry.name}`
      if (isTreeMode(entry.mode)) await walk(entry.id, `${path}/`)
      else await inspectEntry(source, match, path, entry.mode, entry.id, commit, out)
    }
  }
  await walk(parseCommit((await read(source, commit)).data).tree, '')
  return out
}

export type ContentInspection = {
  readonly source: ObjectSource
  readonly isNew: (id: ObjectId) => boolean
  readonly commands: readonly RefCommand[]
}

export type ContentPolicy = (inspection: ContentInspection) => Promise<ReadonlyMap<string, string>>

export const restrictedContentPolicy =
  (match: PathMatcher, record?: (pointers: readonly RestrictedPointer[]) => Promise<void>): ContentPolicy =>
  async ({ source, isNew, commands }) => {
    const rejections = new Map<string, string>()
    const pointers: RestrictedPointer[] = []
    for (const command of commands) {
      if (/^0{40}$/.test(command.newId)) continue
      const scan = await scanNewCommits(source, isNew, [command.newId], match)
      pointers.push(...scan.pointers)
      const [first] = scan.violations
      if (first) rejections.set(command.name, `restricted path ${first.path} must be an LFS pointer`)
    }
    if (record && pointers.length > 0) await record(pointers)
    return rejections
  }
