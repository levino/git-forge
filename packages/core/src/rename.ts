import { isBinaryContent } from './diff.ts'
import type { ObjectId } from './hash.ts'
import type { TreeEntry } from './objects.ts'

export const MAX_SCORE = 60000
export const DEFAULT_RENAME_SCORE = 30000
export const BASENAME_RENAME_SCORE = DEFAULT_RENAME_SCORE + Math.trunc(0.5 * (MAX_SCORE - DEFAULT_RENAME_SCORE))
export const MERGE_RENAME_LIMIT = 7000
export const EMPTY_BLOB_ID = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'

const HASHBASE = 107927
const CANDIDATES_PER_DESTINATION = 4

export type SpanHashes = { readonly size: number; readonly counts: ReadonlyMap<number, number> }

export const spanHashes = (data: Uint8Array): SpanHashes => {
  const text = !isBinaryContent(data)
  const counts = new Map<number, number>()
  let n = 0
  let accum1 = 0
  let accum2 = 0
  for (let i = 0; i < data.length; i++) {
    const c = data[i]!
    const old1 = accum1
    if (text && c === 13 && i + 1 < data.length && data[i + 1] === 10) continue
    accum1 = ((accum1 << 7) ^ (accum2 >>> 25)) >>> 0
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0
    accum1 = (accum1 + c) >>> 0
    if (++n < 64 && c !== 10) continue
    const hash = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE
    counts.set(hash, (counts.get(hash) ?? 0) + n)
    n = 0
    accum1 = 0
    accum2 = 0
  }
  return { size: data.length, counts }
}

export const isRegularMode = (mode: string): boolean => mode === '100644' || mode === '100755' || mode === '100664'

export const estimateSimilarity = (source: SpanHashes, target: SpanHashes, minimumScore: number): number => {
  const max = Math.max(source.size, target.size)
  const delta = max - Math.min(source.size, target.size)
  if (max * (MAX_SCORE - minimumScore) < delta * MAX_SCORE) return 0
  let copied = 0
  for (const [hash, count] of source.counts) copied += Math.min(count, target.counts.get(hash) ?? 0)
  if (target.size === 0) return 0
  return Math.floor((copied * MAX_SCORE) / max)
}

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const dirname = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export type RenameSource = { readonly path: string; readonly entry: TreeEntry; readonly relevant: boolean }

export type RenameTarget = { readonly path: string; readonly entry: TreeEntry }

export type RenameOptions = {
  readonly read: (id: ObjectId) => Promise<Uint8Array>
  readonly isDirectoryRemoved: (directory: string) => Promise<boolean>
  readonly maxComparisons?: number
}

export type RenameDetection =
  | { readonly ok: true; readonly renames: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly reason: 'ambiguous' | 'too-many' }

export const DEFAULT_MAX_COMPARISONS = 250_000

type Score = { src: number; dst: number; score: number; nameScore: number }

const compareScores = (a: Score, b: Score): number => {
  if (a.dst < 0) return b.dst >= 0 ? 1 : 0
  if (b.dst < 0) return -1
  if (a.score === b.score) return b.nameScore - a.nameScore
  return b.score - a.score
}

const recordIfBetter = (slots: Score[], candidate: Score): void => {
  let worst = 0
  for (let i = 1; i < CANDIDATES_PER_DESTINATION; i++) if (compareScores(slots[i]!, slots[worst]!) > 0) worst = i
  if (compareScores(slots[worst]!, candidate) > 0) slots[worst] = candidate
}

const exactKey = (entry: TreeEntry): string => entry.id

const compatibleExact = (source: TreeEntry, target: TreeEntry): boolean =>
  source.id === target.id && (isRegularMode(source.mode) && isRegularMode(target.mode) ? true : source.mode === target.mode)

class Ambiguous extends Error {}

export const detectRenames = async (
  allSources: readonly RenameSource[],
  allTargets: readonly RenameTarget[],
  options: RenameOptions,
): Promise<RenameDetection> => {
  const sources = allSources.filter((source) => source.entry.id !== EMPTY_BLOB_ID)
  const targets = allTargets.filter((target) => target.entry.id !== EMPTY_BLOB_ID)
  const renames = new Map<string, string>()
  if (sources.length === 0 || targets.length === 0 || !sources.some((source) => source.relevant)) return { ok: true, renames }
  const used = new Set<number>()
  const renamed = new Set<number>()
  const exactPairs: [number, number][] = []
  const byId = new Map<string, number[]>()
  sources.forEach((source, index) => byId.set(exactKey(source.entry), [...(byId.get(exactKey(source.entry)) ?? []), index]))
  const targetsById = new Map<string, number[]>()
  targets.forEach((target, index) => targetsById.set(exactKey(target.entry), [...(targetsById.get(exactKey(target.entry)) ?? []), index]))
  for (let d = 0; d < targets.length; d++) {
    const target = targets[d]!
    const candidates = (byId.get(exactKey(target.entry)) ?? []).filter((s) => compatibleExact(sources[s]!.entry, target.entry))
    if (candidates.length === 0) continue
    const competing = (targetsById.get(exactKey(target.entry)) ?? []).filter((other) => candidates.some((s) => compatibleExact(sources[s]!.entry, targets[other]!.entry)))
    if (candidates.length > 1 || competing.length > 1) return { ok: false, reason: 'ambiguous' }
    const s = candidates[0]!
    used.add(s)
    renamed.add(d)
    exactPairs.push([s, d])
    renames.set(sources[s]!.path, target.path)
  }

  const hashes = new Map<ObjectId, SpanHashes>()
  const hashesOf = async (entry: TreeEntry): Promise<SpanHashes> => {
    const known = hashes.get(entry.id)
    if (known) return known
    const computed = spanHashes(await options.read(entry.id))
    hashes.set(entry.id, computed)
    return computed
  }
  const similarity = async (source: TreeEntry, target: TreeEntry, minimum: number): Promise<number> => {
    if (!isRegularMode(source.mode) || !isRegularMode(target.mode)) return 0
    return estimateSimilarity(await hashesOf(source), await hashesOf(target), minimum)
  }
  const record = (s: number, d: number) => {
    used.add(s)
    renamed.add(d)
    renames.set(sources[s]!.path, targets[d]!.path)
  }

  try {
    const remaining = sources.map((_, index) => index).filter((index) => !used.has(index))
    const sourceBases = new Map<string, number>()
    for (const index of remaining) {
      const base = basename(sources[index]!.path)
      sourceBases.set(base, sourceBases.has(base) ? -1 : index)
    }
    const targetBases = new Map<string, number>()
    const unrenamedTargets = new Map<string, number>()
    targets.forEach((target, index) => {
      if (renamed.has(index)) return
      const base = basename(target.path)
      targetBases.set(base, targetBases.has(base) ? -1 : index)
      unrenamedTargets.set(target.path, index)
    })
    const guesses = new Map<string, string | Ambiguous | null>()
    const guessFor = async (directory: string): Promise<string | null> => {
      if (!guesses.has(directory)) {
        let guess: string | Ambiguous | null = null
        if (await options.isDirectoryRemoved(directory)) {
          const counts = new Map<string, number>()
          for (const [s, d] of exactPairs) {
            if (dirname(sources[s]!.path) !== directory) continue
            const target = dirname(targets[d]!.path)
            counts.set(target, (counts.get(target) ?? 0) + 1)
          }
          const best = Math.max(0, ...counts.values())
          const winners = [...counts.entries()].filter(([, count]) => count === best)
          guess = best === 0 ? null : winners.length > 1 ? new Ambiguous() : winners[0]![0]
        }
        guesses.set(directory, guess)
      }
      const guess = guesses.get(directory)!
      if (guess instanceof Ambiguous) throw guess
      return guess
    }
    for (const index of remaining) {
      const source = sources[index]!
      if (!source.relevant) continue
      const base = basename(source.path)
      if (!targetBases.has(base)) continue
      let d = targetBases.get(base)!
      if (sourceBases.get(base) === -1 || d === -1) {
        const guess = await guessFor(dirname(source.path))
        d = guess === null ? -1 : (unrenamedTargets.get(`${guess}/${base}`) ?? -1)
      }
      if (d === -1 || renamed.has(d)) continue
      const score = await similarity(source.entry, targets[d]!.entry, BASENAME_RENAME_SCORE)
      if (score < BASENAME_RENAME_SCORE) continue
      record(index, d)
    }
  } catch (error) {
    if (error instanceof Ambiguous) return { ok: false, reason: 'ambiguous' }
    throw error
  }

  const inexactSources = sources.map((_, index) => index).filter((index) => !used.has(index) && sources[index]!.relevant)
  const inexactTargets = targets.map((_, index) => index).filter((index) => !renamed.has(index))
  if (inexactSources.length === 0 || inexactTargets.length === 0) return { ok: true, renames }
  const comparisons = inexactSources.length * inexactTargets.length
  if (comparisons > MERGE_RENAME_LIMIT * MERGE_RENAME_LIMIT) return { ok: true, renames }
  if (comparisons > (options.maxComparisons ?? DEFAULT_MAX_COMPARISONS)) return { ok: false, reason: 'too-many' }
  const matrix: Score[] = []
  for (const d of inexactTargets) {
    const slots: Score[] = Array.from({ length: CANDIDATES_PER_DESTINATION }, () => ({ src: -1, dst: -1, score: 0, nameScore: 0 }))
    for (const s of inexactSources) {
      recordIfBetter(slots, {
        src: s,
        dst: d,
        score: await similarity(sources[s]!.entry, targets[d]!.entry, DEFAULT_RENAME_SCORE),
        nameScore: basename(sources[s]!.path) === basename(targets[d]!.path) ? 1 : 0,
      })
    }
    matrix.push(...slots)
  }
  matrix.sort(compareScores)
  const usable = matrix.filter((entry) => entry.dst >= 0 && entry.score >= DEFAULT_RENAME_SCORE)
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length && compareScores(usable[i]!, usable[j]!) === 0; j++) {
      if (usable[i]!.src === usable[j]!.src && usable[i]!.dst !== usable[j]!.dst) return { ok: false, reason: 'ambiguous' }
    }
  }
  for (const entry of usable) {
    if (renamed.has(entry.dst) || used.has(entry.src)) continue
    record(entry.src, entry.dst)
  }
  return { ok: true, renames }
}
