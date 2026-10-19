export type Change = {
  readonly i1: number
  readonly chg1: number
  readonly i2: number
  readonly chg2: number
}

const MAX_EQLIMIT = 1024
const SIMSCAN_WINDOW = 100
const KPDIS_RUN = 4
const MAX_COST_MIN = 256
const SNAKE_CNT = 20
const HEUR_MIN_COST = 256
const K_HEUR = 4
const LINE_MAX = Number.MAX_SAFE_INTEGER

const latin1 = new TextDecoder('latin1')

export const splitLines = (data: Uint8Array): Uint8Array[] => {
  const lines: Uint8Array[] = []
  let start = 0
  for (;;) {
    const newline = data.indexOf(0x0a, start)
    if (newline === -1) break
    lines.push(data.subarray(start, newline + 1))
    start = newline + 1
  }
  if (start < data.length) lines.push(data.subarray(start))
  return lines
}

const bogosqrt = (n: number): number => {
  let i = 1
  for (let rest = n; rest > 0; rest = Math.floor(rest / 4)) i *= 2
  return i
}

type DiffFile = {
  readonly nrec: number
  readonly ha: Int32Array
  readonly rchg: Uint8Array
  readonly rindex: Int32Array
  readonly reduced: Int32Array
  nreff: number
  dstart: number
  dend: number
}

const changed = (file: DiffFile, index: number): boolean => index >= 0 && index < file.nrec && file.rchg[index + 1] === 1

const setChanged = (file: DiffFile, index: number, value: 0 | 1) => {
  file.rchg[index + 1] = value
}

const newFile = (ha: Int32Array): DiffFile => ({
  nrec: ha.length,
  ha,
  rchg: new Uint8Array(ha.length + 2),
  rindex: new Int32Array(ha.length),
  reduced: new Int32Array(ha.length),
  nreff: 0,
  dstart: 0,
  dend: -1,
})

const cleanMultimatch = (dis: Uint8Array, i: number, start: number, end: number): boolean => {
  let s = start
  let e = end
  if (i - s > SIMSCAN_WINDOW) s = i - SIMSCAN_WINDOW
  if (e - i > SIMSCAN_WINDOW) e = i + SIMSCAN_WINDOW
  let rdis0 = 0
  let rpdis0 = 1
  for (let r = 1; i - r >= s; r++) {
    const value = dis[i - r]
    if (value === 0) rdis0++
    else if (value === 2) rpdis0++
    else break
  }
  if (rdis0 === 0) return false
  let rdis1 = 0
  let rpdis1 = 1
  for (let r = 1; i + r <= e; r++) {
    const value = dis[i + r]
    if (value === 0) rdis1++
    else if (value === 2) rpdis1++
    else break
  }
  if (rdis1 === 0) return false
  rdis1 += rdis0
  rpdis1 += rpdis0
  return rpdis1 * KPDIS_RUN < rpdis1 + rdis1
}

const prepare = (lines1: readonly Uint8Array[], lines2: readonly Uint8Array[]): [DiffFile, DiffFile] => {
  const classes = new Map<string, number>()
  const count1: number[] = []
  const count2: number[] = []
  const classify = (lines: readonly Uint8Array[], counts: number[], other: number[]): Int32Array => {
    const ha = new Int32Array(lines.length)
    lines.forEach((line, index) => {
      const key = latin1.decode(line)
      let id = classes.get(key)
      if (id === undefined) {
        id = classes.size
        classes.set(key, id)
        counts.push(0)
        other.push(0)
      }
      counts[id]!++
      ha[index] = id
    })
    return ha
  }
  const file1 = newFile(classify(lines1, count1, count2))
  const file2 = newFile(classify(lines2, count2, count1))
  const lim = Math.min(file1.nrec, file2.nrec)
  let head = 0
  while (head < lim && file1.ha[head] === file2.ha[head]) head++
  let tail = 0
  while (tail < lim - head && file1.ha[file1.nrec - 1 - tail] === file2.ha[file2.nrec - 1 - tail]) tail++
  file1.dstart = file2.dstart = head
  file1.dend = file1.nrec - tail - 1
  file2.dend = file2.nrec - tail - 1
  const dis1 = new Uint8Array(file1.nrec + 1)
  const dis2 = new Uint8Array(file2.nrec + 1)
  const mark = (file: DiffFile, dis: Uint8Array, otherCounts: readonly number[]) => {
    const mlim = Math.min(bogosqrt(file.nrec), MAX_EQLIMIT)
    for (let i = file.dstart; i <= file.dend; i++) {
      const matches = otherCounts[file.ha[i]!] ?? 0
      dis[i] = matches === 0 ? 0 : matches >= mlim ? 2 : 1
    }
  }
  mark(file1, dis1, count2)
  mark(file2, dis2, count1)
  const reduce = (file: DiffFile, dis: Uint8Array) => {
    let nreff = 0
    for (let i = file.dstart; i <= file.dend; i++) {
      if (dis[i] === 1 || (dis[i] === 2 && !cleanMultimatch(dis, i, file.dstart, file.dend))) {
        file.rindex[nreff] = i
        file.reduced[nreff] = file.ha[i]!
        nreff++
      } else setChanged(file, i, 1)
    }
    file.nreff = nreff
  }
  reduce(file1, dis1)
  reduce(file2, dis2)
  return [file1, file2]
}

type Split = { i1: number; i2: number; minLo: boolean; minHi: boolean }

type Environment = {
  readonly mxcost: number
  readonly kvdf: Float64Array
  readonly kvdb: Float64Array
  readonly offset: number
}

const split = (ha1: Int32Array, off1: number, lim1: number, ha2: Int32Array, off2: number, lim2: number, needMin: boolean, env: Environment): Split => {
  const { kvdf, kvdb, offset } = env
  const dmin = off1 - lim2
  const dmax = lim1 - off2
  const fmid = off1 - off2
  const bmid = lim1 - lim2
  const odd = ((fmid - bmid) & 1) !== 0
  let fmin = fmid
  let fmax = fmid
  let bmin = bmid
  let bmax = bmid
  kvdf[fmid + offset] = off1
  kvdb[bmid + offset] = lim1
  for (let ec = 1; ; ec++) {
    let gotSnake = false
    if (fmin > dmin) kvdf[--fmin - 1 + offset] = -1
    else ++fmin
    if (fmax < dmax) kvdf[++fmax + 1 + offset] = -1
    else --fmax
    for (let d = fmax; d >= fmin; d -= 2) {
      let i1 = kvdf[d - 1 + offset]! >= kvdf[d + 1 + offset]! ? kvdf[d - 1 + offset]! + 1 : kvdf[d + 1 + offset]!
      const prev1 = i1
      let i2 = i1 - d
      while (i1 < lim1 && i2 < lim2 && ha1[i1] === ha2[i2]) {
        i1++
        i2++
      }
      if (i1 - prev1 > SNAKE_CNT) gotSnake = true
      kvdf[d + offset] = i1
      if (odd && bmin <= d && d <= bmax && kvdb[d + offset]! <= i1) return { i1, i2, minLo: true, minHi: true }
    }
    if (bmin > dmin) kvdb[--bmin - 1 + offset] = LINE_MAX
    else ++bmin
    if (bmax < dmax) kvdb[++bmax + 1 + offset] = LINE_MAX
    else --bmax
    for (let d = bmax; d >= bmin; d -= 2) {
      let i1 = kvdb[d - 1 + offset]! < kvdb[d + 1 + offset]! ? kvdb[d - 1 + offset]! : kvdb[d + 1 + offset]! - 1
      const prev1 = i1
      let i2 = i1 - d
      while (i1 > off1 && i2 > off2 && ha1[i1 - 1] === ha2[i2 - 1]) {
        i1--
        i2--
      }
      if (prev1 - i1 > SNAKE_CNT) gotSnake = true
      kvdb[d + offset] = i1
      if (!odd && fmin <= d && d <= fmax && i1 <= kvdf[d + offset]!) return { i1, i2, minLo: true, minHi: true }
    }
    if (needMin) continue
    if (gotSnake && ec > HEUR_MIN_COST) {
      let best = 0
      let found: Split | null = null
      for (let d = fmax; d >= fmin; d -= 2) {
        const dd = d > fmid ? d - fmid : fmid - d
        const i1 = kvdf[d + offset]!
        const i2 = i1 - d
        const v = i1 - off1 + (i2 - off2) - dd
        if (v > K_HEUR * ec && v > best && off1 + SNAKE_CNT <= i1 && i1 < lim1 && off2 + SNAKE_CNT <= i2 && i2 < lim2) {
          for (let k = 1; ha1[i1 - k] === ha2[i2 - k]; k++) {
            if (k === SNAKE_CNT) {
              best = v
              found = { i1, i2, minLo: true, minHi: false }
              break
            }
          }
        }
      }
      if (found) return found
      best = 0
      for (let d = bmax; d >= bmin; d -= 2) {
        const dd = d > bmid ? d - bmid : bmid - d
        const i1 = kvdb[d + offset]!
        const i2 = i1 - d
        const v = lim1 - i1 + (lim2 - i2) - dd
        if (v > K_HEUR * ec && v > best && off1 < i1 && i1 <= lim1 - SNAKE_CNT && off2 < i2 && i2 <= lim2 - SNAKE_CNT) {
          for (let k = 0; ha1[i1 + k] === ha2[i2 + k]; k++) {
            if (k === SNAKE_CNT - 1) {
              best = v
              found = { i1, i2, minLo: false, minHi: true }
              break
            }
          }
        }
      }
      if (found) return found
    }
    if (ec >= env.mxcost) {
      let fbest = -1
      let fbest1 = -1
      for (let d = fmax; d >= fmin; d -= 2) {
        let i1 = Math.min(kvdf[d + offset]!, lim1)
        let i2 = i1 - d
        if (lim2 < i2) {
          i1 = lim2 + d
          i2 = lim2
        }
        if (fbest < i1 + i2) {
          fbest = i1 + i2
          fbest1 = i1
        }
      }
      let bbest = LINE_MAX
      let bbest1 = LINE_MAX
      for (let d = bmax; d >= bmin; d -= 2) {
        let i1 = Math.max(off1, kvdb[d + offset]!)
        let i2 = i1 - d
        if (i2 < off2) {
          i1 = off2 + d
          i2 = off2
        }
        if (i1 + i2 < bbest) {
          bbest = i1 + i2
          bbest1 = i1
        }
      }
      if (lim1 + lim2 - bbest < fbest - (off1 + off2)) return { i1: fbest1, i2: fbest - fbest1, minLo: true, minHi: false }
      return { i1: bbest1, i2: bbest - bbest1, minLo: false, minHi: true }
    }
  }
}

const compareRecords = (file1: DiffFile, start1: number, end1: number, file2: DiffFile, start2: number, end2: number, needMin: boolean, env: Environment) => {
  const stack: [number, number, number, number, boolean][] = [[start1, end1, start2, end2, needMin]]
  const ha1 = file1.reduced
  const ha2 = file2.reduced
  while (stack.length > 0) {
    let [off1, lim1, off2, lim2, min] = stack.pop()!
    while (off1 < lim1 && off2 < lim2 && ha1[off1] === ha2[off2]) {
      off1++
      off2++
    }
    while (off1 < lim1 && off2 < lim2 && ha1[lim1 - 1] === ha2[lim2 - 1]) {
      lim1--
      lim2--
    }
    if (off1 === lim1) {
      for (; off2 < lim2; off2++) setChanged(file2, file2.rindex[off2]!, 1)
    } else if (off2 === lim2) {
      for (; off1 < lim1; off1++) setChanged(file1, file1.rindex[off1]!, 1)
    } else {
      const spl = split(ha1, off1, lim1, ha2, off2, lim2, min, env)
      stack.push([spl.i1, lim1, spl.i2, lim2, spl.minHi])
      stack.push([off1, spl.i1, off2, spl.i2, spl.minLo])
    }
  }
}

type Group = { start: number; end: number }

const groupInit = (file: DiffFile): Group => {
  const group = { start: 0, end: 0 }
  while (changed(file, group.end)) group.end++
  return group
}

const groupNext = (file: DiffFile, group: Group): boolean => {
  if (group.end === file.nrec) return false
  group.start = group.end + 1
  group.end = group.start
  while (changed(file, group.end)) group.end++
  return true
}

const groupPrevious = (file: DiffFile, group: Group): boolean => {
  if (group.start === 0) return false
  group.end = group.start - 1
  group.start = group.end
  while (changed(file, group.start - 1)) group.start--
  return true
}

const groupSlideDown = (file: DiffFile, group: Group): boolean => {
  if (group.end < file.nrec && file.ha[group.start] === file.ha[group.end]) {
    setChanged(file, group.start++, 0)
    setChanged(file, group.end++, 1)
    while (changed(file, group.end)) group.end++
    return true
  }
  return false
}

const groupSlideUp = (file: DiffFile, group: Group): boolean => {
  if (group.start > 0 && file.ha[group.start - 1] === file.ha[group.end - 1]) {
    setChanged(file, --group.start, 1)
    setChanged(file, --group.end, 0)
    while (changed(file, group.start - 1)) group.start--
    return true
  }
  return false
}

const syncBroken = (): never => {
  throw new Error('xdiff group sync broken')
}

const changeCompact = (file: DiffFile, other: DiffFile) => {
  const g = groupInit(file)
  const go = groupInit(other)
  for (;;) {
    if (g.end !== g.start) {
      let groupSize: number
      let earliestEnd: number
      let endMatchingOther: number
      do {
        groupSize = g.end - g.start
        endMatchingOther = -1
        while (groupSlideUp(file, g)) if (!groupPrevious(other, go)) syncBroken()
        earliestEnd = g.end
        if (go.end > go.start) endMatchingOther = g.end
        for (;;) {
          if (!groupSlideDown(file, g)) break
          if (!groupNext(other, go)) syncBroken()
          if (go.end > go.start) endMatchingOther = g.end
        }
      } while (groupSize !== g.end - g.start)
      if (g.end !== earliestEnd && endMatchingOther !== -1) {
        while (go.end === go.start) {
          if (!groupSlideUp(file, g)) syncBroken()
          if (!groupPrevious(other, go)) syncBroken()
        }
      }
    }
    if (!groupNext(file, g)) break
    if (!groupNext(other, go)) syncBroken()
  }
}

const buildScript = (file1: DiffFile, file2: DiffFile): Change[] => {
  const changes: Change[] = []
  let i1 = file1.nrec
  let i2 = file2.nrec
  while (i1 >= 0 || i2 >= 0) {
    if (changed(file1, i1 - 1) || changed(file2, i2 - 1)) {
      const l1 = i1
      const l2 = i2
      while (changed(file1, i1 - 1)) i1--
      while (changed(file2, i2 - 1)) i2--
      changes.push({ i1, chg1: l1 - i1, i2, chg2: l2 - i2 })
    }
    i1--
    i2--
  }
  return changes.reverse()
}

export const diffLines = (lines1: readonly Uint8Array[], lines2: readonly Uint8Array[]): Change[] => {
  const [file1, file2] = prepare(lines1, lines2)
  const ndiags = file1.nreff + file2.nreff + 3
  const env: Environment = {
    mxcost: Math.max(bogosqrt(ndiags), MAX_COST_MIN),
    kvdf: new Float64Array(ndiags + 2),
    kvdb: new Float64Array(ndiags + 2),
    offset: file2.nreff + 1,
  }
  compareRecords(file1, 0, file1.nreff, file2, 0, file2.nreff, false, env)
  changeCompact(file1, file2)
  changeCompact(file2, file1)
  return buildScript(file1, file2)
}

type MergeRegion = { mode: number; i0: number; chg0: number; i1: number; chg1: number; i2: number; chg2: number }

const sameLines = (a: readonly Uint8Array[], aStart: number, b: readonly Uint8Array[], bStart: number, count: number): boolean => {
  for (let k = 0; k < count; k++) {
    const x = a[aStart + k]!
    const y = b[bStart + k]!
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  }
  return true
}

const appendMerge = (regions: MergeRegion[], mode: number, i0: number, chg0: number, i1: number, chg1: number, i2: number, chg2: number) => {
  const last = regions[regions.length - 1]
  if (last && (i1 <= last.i1 + last.chg1 || i2 <= last.i2 + last.chg2)) {
    if (mode !== last.mode) last.mode = 0
    last.chg0 = i0 + chg0 - last.i0
    last.chg1 = i1 + chg1 - last.i1
    last.chg2 = i2 + chg2 - last.i2
  } else regions.push({ mode, i0, chg0, i1, chg1, i2, chg2 })
}

export type TextMerge = { readonly clean: true; readonly lines: readonly Uint8Array[] } | { readonly clean: false; readonly conflicts: number }

const mergeRegions = (base: readonly Uint8Array[], ours: readonly Uint8Array[], theirs: readonly Uint8Array[]): { readonly lines: readonly Uint8Array[] } | { readonly regions: MergeRegion[] } => {
  const script1 = diffLines(base, ours)
  const script2 = diffLines(base, theirs)
  if (script1.length === 0) return { lines: theirs }
  if (script2.length === 0) return { lines: ours }
  const regions: MergeRegion[] = []
  let a = 0
  let b = 0
  while (a < script1.length && b < script2.length) {
    const x = script1[a]!
    const y = script2[b]!
    if (x.i1 + x.chg1 < y.i1) {
      appendMerge(regions, 1, x.i1, x.chg1, x.i2, x.chg2, y.i2 - y.i1 + x.i1, x.chg1)
      a++
      continue
    }
    if (y.i1 + y.chg1 < x.i1) {
      appendMerge(regions, 2, y.i1, y.chg1, x.i2 - x.i1 + y.i1, y.chg1, y.i2, y.chg2)
      b++
      continue
    }
    if (x.i1 !== y.i1 || x.chg1 !== y.chg1 || x.chg2 !== y.chg2 || !sameLines(ours, x.i2, theirs, y.i2, x.chg2)) {
      const off = x.i1 - y.i1
      const ffo = off + x.chg1 - y.chg1
      let i0 = x.i1
      let i1 = x.i2
      let i2 = y.i2
      if (off > 0) {
        i0 -= off
        i1 -= off
      } else i2 += off
      let chg0 = x.i1 + x.chg1 - i0
      let chg1 = x.i2 + x.chg2 - i1
      let chg2 = y.i2 + y.chg2 - i2
      if (ffo < 0) {
        chg0 -= ffo
        chg1 -= ffo
      } else chg2 += ffo
      appendMerge(regions, 0, i0, chg0, i1, chg1, i2, chg2)
    }
    const end1 = x.i1 + x.chg1
    const end2 = y.i1 + y.chg1
    if (end1 >= end2) b++
    if (end2 >= end1) a++
  }
  for (; a < script1.length; a++) {
    const x = script1[a]!
    appendMerge(regions, 1, x.i1, x.chg1, x.i2, x.chg2, x.i1 + theirs.length - base.length, x.chg1)
  }
  for (; b < script2.length; b++) {
    const y = script2[b]!
    appendMerge(regions, 2, y.i1, y.chg1, y.i1 + ours.length - base.length, y.chg1, y.i2, y.chg2)
  }
  const refined: MergeRegion[] = []
  for (const region of regions) {
    if (region.mode !== 0 || region.chg1 === 0 || region.chg2 === 0) {
      refined.push(region)
      continue
    }
    const inner = diffLines(ours.slice(region.i1, region.i1 + region.chg1), theirs.slice(region.i2, region.i2 + region.chg2))
    if (inner.length === 0) {
      refined.push({ ...region, mode: 4 })
      continue
    }
    for (const change of inner) refined.push({ mode: 0, i0: region.i0, chg0: region.chg0, i1: change.i1 + region.i1, chg1: change.chg1, i2: change.i2 + region.i2, chg2: change.chg2 })
  }
  const simplified: MergeRegion[] = []
  for (const region of refined) {
    const last = simplified[simplified.length - 1]
    if (last && last.mode === 0 && region.mode === 0 && region.i1 - (last.i1 + last.chg1) <= 3) {
      last.chg0 = region.i0 + region.chg0 - last.i0
      last.chg1 = region.i1 + region.chg1 - last.i1
      last.chg2 = region.i2 + region.chg2 - last.i2
    } else simplified.push({ ...region })
  }
  return { regions: simplified }
}

const fillMerge = (regions: readonly MergeRegion[], ours: readonly Uint8Array[], theirs: readonly Uint8Array[], conflict: (region: MergeRegion) => Uint8Array[]): Uint8Array[] => {
  const lines: Uint8Array[] = []
  let position = 0
  for (const region of regions) {
    if (region.mode !== 0 && (region.mode & 3) === 0) continue
    lines.push(...ours.slice(position, region.i1))
    if (region.mode === 0) lines.push(...conflict(region))
    if (region.mode & 1) lines.push(...ours.slice(region.i1, region.i1 + region.chg1))
    if (region.mode & 2) lines.push(...theirs.slice(region.i2, region.i2 + region.chg2))
    position = region.i1 + region.chg1
  }
  lines.push(...ours.slice(position))
  return lines
}

export const mergeLines = (base: readonly Uint8Array[], ours: readonly Uint8Array[], theirs: readonly Uint8Array[]): TextMerge => {
  const merged = mergeRegions(base, ours, theirs)
  if ('lines' in merged) return { clean: true, lines: merged.lines }
  const conflicts = merged.regions.filter((region) => region.mode === 0).length
  if (conflicts > 0) return { clean: false, conflicts }
  return { clean: true, lines: fillMerge(merged.regions, ours, theirs, () => []) }
}

const marker = (text: string): Uint8Array => new TextEncoder().encode(text)

const terminated = (lines: readonly Uint8Array[]): Uint8Array[] => {
  const last = lines[lines.length - 1]
  if (!last || last[last.length - 1] === 0x0a) return [...lines]
  return [...lines.slice(0, -1), new Uint8Array([...last, 0x0a])]
}

export const conflictLines = (base: readonly Uint8Array[], ours: readonly Uint8Array[], theirs: readonly Uint8Array[], labels: readonly [string, string]): Uint8Array[] => {
  const merged = mergeRegions(base, ours, theirs)
  if ('lines' in merged) return [...merged.lines]
  return fillMerge(merged.regions, ours, theirs, (region) => [
    marker(`<<<<<<< ${labels[0]}\n`),
    ...terminated(ours.slice(region.i1, region.i1 + region.chg1)),
    marker('=======\n'),
    ...terminated(theirs.slice(region.i2, region.i2 + region.chg2)),
    marker(`>>>>>>> ${labels[1]}\n`),
  ])
}
