import { type CommitInfo, entryAt, readCommit } from './browse.ts'
import type { ObjectId } from './hash.ts'
import type { ObjectDatabase } from './repository.ts'
import { diffLines, splitLines } from './xdiff.ts'

export type BlameRange = { readonly start: number; readonly count: number; readonly commit: CommitInfo | null; readonly sourceLine: number }

export type Blame = { readonly lines: number; readonly ranges: readonly BlameRange[]; readonly complete: boolean; readonly walked: number }

export const DEFAULT_BLAME_COMMITS = 500

export const MAX_BLAME_BYTES = 512 * 1024

type Pending = { readonly commit: CommitInfo; readonly blob: ObjectId; lines: [final: number, here: number][] }

const blobLines = async (odb: ObjectDatabase, id: ObjectId): Promise<Uint8Array[] | null> => {
  const object = await odb.read(id)
  return object?.type === 'blob' && object.data.length <= MAX_BLAME_BYTES ? splitLines(object.data) : null
}

const unchanged = (parentLines: readonly Uint8Array[], lines: readonly Uint8Array[]): Map<number, number> => {
  const mapping = new Map<number, number>()
  let i1 = 0
  let i2 = 0
  for (const change of [...diffLines(parentLines, lines), { i1: parentLines.length, chg1: 0, i2: lines.length, chg2: 0 }]) {
    while (i2 < change.i2) mapping.set(i2++, i1++)
    i1 = change.i1 + change.chg1
    i2 = change.i2 + change.chg2
  }
  return mapping
}

export const blame = async (odb: ObjectDatabase, start: ObjectId, path: readonly string[], maxCommits = DEFAULT_BLAME_COMMITS): Promise<Blame | null> => {
  const head = await readCommit(odb, start)
  const entry = head ? await entryAt(odb, head.tree, path) : null
  const lines = entry ? await blobLines(odb, entry.id) : null
  if (!head || !entry || !lines) return null
  const owners: ({ commit: CommitInfo | null; line: number } | undefined)[] = new Array(lines.length)
  const queue = new Map<ObjectId, Pending>([[head.id, { commit: head, blob: entry.id, lines: lines.map((_, index) => [index, index]) }]])
  let walked = 0
  while (queue.size > 0 && walked < maxCommits) {
    const next = [...queue.values()].reduce((best, candidate) => (candidate.commit.committer.timestamp > best.commit.committer.timestamp ? candidate : best))
    queue.delete(next.commit.id)
    walked++
    let remaining = next.lines
    for (const parentId of next.commit.parents) {
      if (remaining.length === 0) break
      const parent = await readCommit(odb, parentId)
      const parentEntry = parent ? await entryAt(odb, parent.tree, path) : null
      if (!parent || !parentEntry) continue
      let passed: [number, number][]
      if (parentEntry.id === next.blob) {
        passed = remaining
        remaining = []
      } else {
        const [ours, theirs] = await Promise.all([blobLines(odb, next.blob), blobLines(odb, parentEntry.id)])
        if (!ours || !theirs) continue
        const mapping = unchanged(theirs, ours)
        passed = remaining.flatMap(([final, here]) => (mapping.has(here) ? [[final, mapping.get(here)!] as [number, number]] : []))
        remaining = remaining.filter(([, here]) => !mapping.has(here))
      }
      if (passed.length === 0) continue
      const queued = queue.get(parent.id)
      if (queued) queued.lines = [...queued.lines, ...passed]
      else queue.set(parent.id, { commit: parent, blob: parentEntry.id, lines: passed })
    }
    for (const [final, here] of remaining) owners[final] = { commit: next.commit, line: here }
  }
  const ranges: BlameRange[] = []
  for (let index = 0; index < owners.length; index++) {
    const owner = owners[index] ?? { commit: null, line: index }
    const last = ranges[ranges.length - 1]
    if (last && last.commit?.id === owner.commit?.id && last.sourceLine + last.count === owner.line + 1) ranges[ranges.length - 1] = { ...last, count: last.count + 1 }
    else ranges.push({ start: index + 1, count: 1, commit: owner.commit, sourceLine: owner.line + 1 })
  }
  return { lines: lines.length, ranges, complete: queue.size === 0, walked }
}
