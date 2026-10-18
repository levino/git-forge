import { fromUtf8 } from './bytes.ts'
import type { ObjectId } from './hash.ts'
import { parseLfsPointer, type LfsObjectSpec } from './lfs.ts'
import { isSubmodule, isTreeMode, parseTree, type TreeEntry } from './objects.ts'
import { MissingObjectError, type ObjectSource } from './walk.ts'
import { type Change, diffLines, splitLines } from './xdiff.ts'
import { sortTreeEntries } from './commit.ts'

export type FileStatus = 'added' | 'removed' | 'modified' | 'renamed'

export type TreeChange = {
  readonly status: FileStatus
  readonly path: string
  readonly previousPath: string | null
  readonly oldMode: string | null
  readonly newMode: string | null
  readonly oldId: ObjectId | null
  readonly newId: ObjectId | null
}

const readTree = async (source: ObjectSource, id: ObjectId | null): Promise<TreeEntry[]> => {
  if (id === null) return []
  const object = await source.read(id)
  if (!object) throw new MissingObjectError(id)
  if (object.type !== 'tree') throw new Error(`${id} is not a tree`)
  return sortTreeEntries(parseTree(object.data))
}

const treeKey = (entry: TreeEntry): string => (isTreeMode(entry.mode) ? `${entry.name}/` : entry.name)

const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const fileKind = (mode: string): string => (mode === '120000' ? 'link' : isSubmodule({ mode, name: '', id: '' }) ? 'submodule' : 'file')

const walkTrees = async (source: ObjectSource, oldTree: ObjectId | null, newTree: ObjectId | null, prefix: string, out: TreeChange[]): Promise<void> => {
  const before = new Map((await readTree(source, oldTree)).map((entry) => [treeKey(entry), entry]))
  const after = new Map((await readTree(source, newTree)).map((entry) => [treeKey(entry), entry]))
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort(byteOrder)
  for (const key of keys) {
    const a = before.get(key)
    const b = after.get(key)
    const path = `${prefix}${(a ?? b)!.name}`
    if (a && b && a.id === b.id && a.mode === b.mode) continue
    const aTree = a !== undefined && isTreeMode(a.mode)
    const bTree = b !== undefined && isTreeMode(b.mode)
    if (aTree || bTree) {
      await walkTrees(source, aTree ? a.id : null, bTree ? b.id : null, `${path}/`, out)
      continue
    }
    if (a && b && fileKind(a.mode) !== fileKind(b.mode)) {
      out.push({ status: 'removed', path, previousPath: null, oldMode: a.mode, newMode: null, oldId: a.id, newId: null })
      out.push({ status: 'added', path, previousPath: null, oldMode: null, newMode: b.mode, oldId: null, newId: b.id })
      continue
    }
    out.push({
      status: a && b ? 'modified' : a ? 'removed' : 'added',
      path,
      previousPath: null,
      oldMode: a?.mode ?? null,
      newMode: b?.mode ?? null,
      oldId: a?.id ?? null,
      newId: b?.id ?? null,
    })
  }
}

const pairExactRenames = (changes: readonly TreeChange[]): TreeChange[] => {
  const added = new Map<string, TreeChange[]>()
  for (const change of changes) {
    if (change.status !== 'added') continue
    const key = `${fileKind(change.newMode!)}:${change.newId}`
    added.set(key, [...(added.get(key) ?? []), change])
  }
  const consumed = new Set<TreeChange>()
  const result: TreeChange[] = []
  for (const change of changes) {
    if (change.status !== 'removed') continue
    const candidates = added.get(`${fileKind(change.oldMode!)}:${change.oldId}`)
    const target = candidates?.find((candidate) => !consumed.has(candidate))
    if (!target) continue
    consumed.add(target)
    consumed.add(change)
    result.push({ ...target, status: 'renamed', previousPath: change.path, oldMode: change.oldMode, oldId: change.oldId })
  }
  return [...changes.filter((change) => !consumed.has(change)), ...result].sort((x, y) => byteOrder(x.path, y.path))
}

export type TreeDiffOptions = {
  readonly renames?: boolean
}

export const diffTrees = async (source: ObjectSource, oldTree: ObjectId | null, newTree: ObjectId | null, options: TreeDiffOptions = {}): Promise<TreeChange[]> => {
  const out: TreeChange[] = []
  await walkTrees(source, oldTree, newTree, '', out)
  return options.renames === false ? out : pairExactRenames(out)
}

export const BINARY_SNIFF_BYTES = 8000

export const isBinaryContent = (data: Uint8Array): boolean => data.subarray(0, BINARY_SNIFF_BYTES).includes(0)

export type DiffLine = {
  readonly kind: ' ' | '-' | '+'
  readonly text: string
  readonly oldLine: number | null
  readonly newLine: number | null
  readonly noNewline: boolean
}

export type Hunk = {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly section: string
  readonly lines: readonly DiffLine[]
}

export type BlobDiff = {
  readonly hunks: readonly Hunk[]
  readonly additions: number
  readonly deletions: number
}

const FUNCNAME = /^[A-Za-z_$]/

const sectionHeading = (lines: readonly Uint8Array[], before: number): string => {
  for (let i = before; i >= 0; i--) {
    const line = lines[i]!
    if (line.length === 0 || !FUNCNAME.test(String.fromCharCode(line[0]!))) continue
    return fromUtf8(line.subarray(0, Math.min(line.length, 80))).replace(/\s+$/, '')
  }
  return ''
}

const lineText = (line: Uint8Array): { text: string; noNewline: boolean } => {
  const noNewline = line[line.length - 1] !== 0x0a
  return { text: fromUtf8(noNewline ? line : line.subarray(0, line.length - 1)), noNewline }
}

export const groupHunks = (changes: readonly Change[], context: number): Change[][] => {
  const groups: Change[][] = []
  for (const change of changes) {
    const current = groups[groups.length - 1]
    const previous = current?.[current.length - 1]
    if (current && previous && change.i1 - (previous.i1 + previous.chg1) <= 2 * context) current.push(change)
    else groups.push([change])
  }
  return groups
}

export const diffBlobs = (oldData: Uint8Array, newData: Uint8Array, context = 3): BlobDiff => {
  const a = splitLines(oldData)
  const b = splitLines(newData)
  const changes = diffLines(a, b)
  let additions = 0
  let deletions = 0
  const hunks: Hunk[] = groupHunks(changes, context).map((group) => {
    const first = group[0]!
    const last = group[group.length - 1]!
    const s1 = Math.max(first.i1 - context, 0)
    const s2 = Math.max(first.i2 - context, 0)
    const e1 = Math.min(last.i1 + last.chg1 + context, a.length)
    const e2 = Math.min(last.i2 + last.chg2 + context, b.length)
    const lines: DiffLine[] = []
    let i1 = s1
    let i2 = s2
    const contextUntil = (end1: number) => {
      while (i1 < end1) {
        lines.push({ kind: ' ', ...lineText(a[i1]!), oldLine: i1 + 1, newLine: i2 + 1 })
        i1++
        i2++
      }
    }
    for (const change of group) {
      contextUntil(change.i1)
      for (let k = 0; k < change.chg1; k++) lines.push({ kind: '-', ...lineText(a[change.i1 + k]!), oldLine: change.i1 + k + 1, newLine: null })
      for (let k = 0; k < change.chg2; k++) lines.push({ kind: '+', ...lineText(b[change.i2 + k]!), oldLine: null, newLine: change.i2 + k + 1 })
      deletions += change.chg1
      additions += change.chg2
      i1 = change.i1 + change.chg1
      i2 = change.i2 + change.chg2
    }
    contextUntil(e1)
    return {
      oldStart: e1 - s1 === 0 ? s1 : s1 + 1,
      oldLines: e1 - s1,
      newStart: e2 - s2 === 0 ? s2 : s2 + 1,
      newLines: e2 - s2,
      section: sectionHeading(a, s1 - 1),
      lines,
    }
  })
  return { hunks, additions, deletions }
}

const range = (start: number, count: number): string => (count === 1 ? `${start}` : `${start},${count}`)

export const formatHunks = (hunks: readonly Hunk[]): string =>
  hunks
    .map((hunk) => {
      const header = `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@${hunk.section ? ` ${hunk.section}` : ''}\n`
      return header + hunk.lines.map((line) => `${line.kind}${line.text}\n${line.noNewline ? '\\ No newline at end of file\n' : ''}`).join('')
    })
    .join('')

export type FileKind = 'text' | 'binary' | 'lfs' | 'submodule' | 'large'

export type FileDiff = TreeChange & {
  readonly kind: FileKind
  readonly additions: number
  readonly deletions: number
  readonly hunks: readonly Hunk[]
  readonly lfs: { readonly old: LfsObjectSpec | null; readonly new: LfsObjectSpec | null } | null
}

export type FileDiffOptions = {
  readonly context?: number
  readonly maxBlobBytes?: number
}

export const DEFAULT_MAX_DIFF_BLOB_BYTES = 1024 * 1024

const EMPTY = new Uint8Array(0)

const readBlob = async (source: ObjectSource, id: ObjectId | null): Promise<Uint8Array> => {
  if (id === null) return EMPTY
  const object = await source.read(id)
  if (!object) throw new MissingObjectError(id)
  return object.data
}

export const diffFile = async (source: ObjectSource, change: TreeChange, options: FileDiffOptions = {}): Promise<FileDiff> => {
  const none = { additions: 0, deletions: 0, hunks: [], lfs: null }
  if ((change.oldMode && isSubmodule({ mode: change.oldMode, name: '', id: '' })) || (change.newMode && isSubmodule({ mode: change.newMode, name: '', id: '' }))) {
    return { ...change, ...none, kind: 'submodule' }
  }
  const sameContent = change.oldId === change.newId
  const oldData = sameContent ? EMPTY : await readBlob(source, change.oldId)
  const newData = sameContent ? EMPTY : await readBlob(source, change.newId)
  const max = options.maxBlobBytes ?? DEFAULT_MAX_DIFF_BLOB_BYTES
  if (oldData.length > max || newData.length > max) return { ...change, ...none, kind: 'large' }
  const oldPointer = parseLfsPointer(oldData)
  const newPointer = parseLfsPointer(newData)
  if (!oldPointer && !newPointer && (isBinaryContent(oldData) || isBinaryContent(newData))) return { ...change, ...none, kind: 'binary' }
  const diff = diffBlobs(oldData, newData, options.context ?? 3)
  return {
    ...change,
    ...diff,
    kind: oldPointer || newPointer ? 'lfs' : 'text',
    lfs: oldPointer || newPointer ? { old: oldPointer, new: newPointer } : null,
  }
}

const short = (id: ObjectId | null): string => (id ?? '0'.repeat(40)).slice(0, 7)

export const formatFileDiff = (file: FileDiff): string => {
  const oldPath = file.previousPath ?? file.path
  const lines = [`diff --git a/${oldPath} b/${file.path}`]
  if (file.status === 'added') lines.push(`new file mode ${file.newMode}`)
  if (file.status === 'removed') lines.push(`deleted file mode ${file.oldMode}`)
  if ((file.status === 'modified' || file.status === 'renamed') && file.oldMode !== file.newMode) lines.push(`old mode ${file.oldMode}`, `new mode ${file.newMode}`)
  if (file.status === 'renamed') lines.push(`similarity index ${file.oldId === file.newId ? 100 : 50}%`, `rename from ${oldPath}`, `rename to ${file.path}`)
  if (file.oldId === file.newId) return `${lines.join('\n')}\n`
  const sameMode = file.status === 'modified' && file.oldMode === file.newMode
  lines.push(`index ${short(file.oldId)}..${short(file.newId)}${sameMode ? ` ${file.newMode}` : ''}`)
  const from = file.status === 'added' ? '/dev/null' : `a/${oldPath}`
  const to = file.status === 'removed' ? '/dev/null' : `b/${file.path}`
  if (file.kind === 'binary' || file.kind === 'large') return `${lines.join('\n')}\nBinary files ${from} and ${to} differ\n`
  if (file.kind === 'submodule') {
    const body = [
      ...(file.oldId ? [`-Subproject commit ${file.oldId}`] : []),
      ...(file.newId ? [`+Subproject commit ${file.newId}`] : []),
    ]
    const header = `@@ -${range(file.oldId ? 1 : 0, file.oldId ? 1 : 0)} +${range(file.newId ? 1 : 0, file.newId ? 1 : 0)} @@`
    return `${lines.join('\n')}\n--- ${from}\n+++ ${to}\n${header}\n${body.join('\n')}\n`
  }
  if (file.hunks.length === 0) return `${lines.join('\n')}\n`
  return `${lines.join('\n')}\n--- ${from}\n+++ ${to}\n${formatHunks(file.hunks)}`
}

export const diffTreesWithContent = async (
  source: ObjectSource,
  oldTree: ObjectId | null,
  newTree: ObjectId | null,
  options: FileDiffOptions & TreeDiffOptions = {},
): Promise<FileDiff[]> => {
  const changes = await diffTrees(source, oldTree, newTree, options)
  const files: FileDiff[] = []
  for (const change of changes) files.push(await diffFile(source, change, options))
  return files
}
