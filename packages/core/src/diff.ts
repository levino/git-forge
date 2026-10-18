export type DiffLine =
  | { readonly kind: 'context'; readonly text: string; readonly oldNumber: number; readonly newNumber: number }
  | { readonly kind: 'deleted'; readonly text: string; readonly oldNumber: number }
  | { readonly kind: 'added'; readonly text: string; readonly newNumber: number }

export type Hunk = {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

export type LineDiff = { readonly kind: 'hunks'; readonly hunks: readonly Hunk[]; readonly added: number; readonly deleted: number } | { readonly kind: 'too-large' }

type Edit = { readonly kind: 'equal' | 'deleted' | 'added'; readonly oldIndex: number; readonly newIndex: number }

export const DEFAULT_MAX_EDIT_DISTANCE = 2000

export const splitLines = (text: string): string[] => {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

const myers = (a: readonly string[], b: readonly string[], maxDistance: number): Edit[] | null => {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  const max = n + m
  const trace: Int32Array[] = []
  const v = new Int32Array(2 * max + 3)
  const offset = max + 1
  let distance = -1
  for (let d = 0; d <= max; d++) {
    if (d > maxDistance) return null
    const window = new Int32Array(2 * d + 1)
    for (let k = -d; k <= d; k++) window[k + d] = v[k + offset]!
    trace.push(window)
    let done = false
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!) ? v[k + 1 + offset]! : v[k - 1 + offset]! + 1
      let y = x - k
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++
        y++
      }
      v[k + offset] = x
      if (x >= n && y >= m) {
        done = true
        break
      }
    }
    if (done) {
      distance = d
      break
    }
  }
  const middle: Edit[] = []
  let x = n
  let y = m
  for (let d = distance; d > 0; d--) {
    const window = trace[d]!
    const at = (k: number): number => window[k + d]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const previousK = down ? k + 1 : k - 1
    const previousX = at(previousK)
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) {
      x--
      y--
      middle.push({ kind: 'equal', oldIndex: start + x, newIndex: start + y })
    }
    if (down) {
      y--
      middle.push({ kind: 'added', oldIndex: start + x, newIndex: start + y })
    } else {
      x--
      middle.push({ kind: 'deleted', oldIndex: start + x, newIndex: start + y })
    }
  }
  while (x > 0 && y > 0) {
    x--
    y--
    middle.push({ kind: 'equal', oldIndex: start + x, newIndex: start + y })
  }
  const edits: Edit[] = []
  for (let i = 0; i < start; i++) edits.push({ kind: 'equal', oldIndex: i, newIndex: i })
  edits.push(...middle.reverse())
  for (let i = 0; i < a.length - endA; i++) edits.push({ kind: 'equal', oldIndex: endA + i, newIndex: endB + i })
  return edits
}

export const diffLines = (a: readonly string[], b: readonly string[], options: { readonly context?: number; readonly maxDistance?: number } = {}): LineDiff => {
  const context = options.context ?? 3
  const edits = myers(a, b, options.maxDistance ?? DEFAULT_MAX_EDIT_DISTANCE)
  if (!edits) return { kind: 'too-large' }
  const changed = edits.map((edit, index) => (edit.kind === 'equal' ? -1 : index)).filter((index) => index >= 0)
  const hunks: Hunk[] = []
  let added = 0
  let deleted = 0
  let i = 0
  while (i < changed.length) {
    const first = changed[i]!
    let last = first
    while (i + 1 < changed.length && changed[i + 1]! - last <= 2 * context + 1) last = changed[++i]!
    i++
    const from = Math.max(0, first - context)
    const to = Math.min(edits.length - 1, last + context)
    const lines: DiffLine[] = []
    for (let j = from; j <= to; j++) {
      const edit = edits[j]!
      if (edit.kind === 'equal') lines.push({ kind: 'context', text: a[edit.oldIndex]!, oldNumber: edit.oldIndex + 1, newNumber: edit.newIndex + 1 })
      else if (edit.kind === 'deleted') {
        deleted++
        lines.push({ kind: 'deleted', text: a[edit.oldIndex]!, oldNumber: edit.oldIndex + 1 })
      } else {
        added++
        lines.push({ kind: 'added', text: b[edit.newIndex]!, newNumber: edit.newIndex + 1 })
      }
    }
    const oldLines = lines.filter((line) => line.kind !== 'added').length
    const newLines = lines.filter((line) => line.kind !== 'deleted').length
    const head = edits[from]!
    hunks.push({
      oldStart: oldLines === 0 ? head.oldIndex : head.oldIndex + 1,
      oldLines,
      newStart: newLines === 0 ? head.newIndex : head.newIndex + 1,
      newLines,
      lines,
    })
  }
  return { kind: 'hunks', hunks, added, deleted }
}

export const formatHunkHeader = (hunk: Hunk): string => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
