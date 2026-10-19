import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diffBlobs, formatHunks } from '../src/diff.ts'
import { conflictLines, mergeLines, splitLines } from '../src/xdiff.ts'
import { tempDir } from './git-helpers.ts'

const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

const makeFile = (rand: () => number, alphabet: number, length: number): string[] =>
  Array.from({ length }, () => `line ${Math.floor(rand() * alphabet)}\n`)

const mutate = (rand: () => number, lines: string[], alphabet: number, edits: number): string[] => {
  const out = [...lines]
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(rand() * (out.length + 1))
    const kind = rand()
    const n = 1 + Math.floor(rand() * 3)
    if (kind < 0.33) out.splice(at, n)
    else if (kind < 0.66) out.splice(at, 0, ...makeFile(rand, alphabet * 3, n))
    else out.splice(at, n, ...makeFile(rand, alphabet * 3, n))
  }
  return out
}

const bytes = (lines: string[], newline: boolean) => {
  const text = lines.join('')
  return new TextEncoder().encode(newline || text.length === 0 ? text : text.slice(0, -1))
}

describe('xdiff oracle', () => {
  const dir = tempDir()
  it('matches git diff', () => {
    const rand = random(7)
    for (let round = 0; round < 300; round++) {
      const alphabet = 2 + Math.floor(rand() * 20)
      const a = makeFile(rand, alphabet, Math.floor(rand() * 40))
      const b = mutate(rand, a, alphabet, 1 + Math.floor(rand() * 6))
      const ab = bytes(a, rand() > 0.2)
      const bb = bytes(b, rand() > 0.2)
      writeFileSync(join(dir, 'a'), ab)
      writeFileSync(join(dir, 'b'), bb)
      const result = spawnSync('git', ['diff', '--no-index', '--no-indent-heuristic', '-U3', 'a', 'b'], { cwd: dir, encoding: 'utf8' })
      const expected = result.stdout.includes('@@') ? result.stdout.slice(result.stdout.indexOf('@@')) : ''
      expect(formatHunks(diffBlobs(ab, bb).hunks), `round ${round}`).toBe(expected)
    }
  })
  it('matches git merge-file', () => {
    const rand = random(11)
    let clean = 0
    for (let round = 0; round < 600; round++) {
      const alphabet = 2 + Math.floor(rand() * 30)
      const base = makeFile(rand, alphabet, Math.floor(rand() * 30))
      const ours = mutate(rand, base, alphabet, 1 + Math.floor(rand() * 3))
      const theirs = rand() < 0.1 ? [...ours] : mutate(rand, base, alphabet, 1 + Math.floor(rand() * 3))
      const files = { base: bytes(base, true), ours: bytes(ours, rand() > 0.1), theirs: bytes(theirs, true) }
      for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data)
      const result = spawnSync('git', ['merge-file', '-p', 'ours', 'base', 'theirs'], { cwd: dir })
      const merged = mergeLines(splitLines(files.base), splitLines(files.ours), splitLines(files.theirs))
      if (result.status === 0) {
        clean++
        expect(merged.clean, `round ${round}`).toBe(true)
        if (merged.clean) expect(Buffer.concat(merged.lines.map((l) => Buffer.from(l))).toString('latin1'), `round ${round}`).toBe(result.stdout.toString('latin1'))
      } else {
        expect(merged.clean, `round ${round}`).toBe(false)
        const marked = conflictLines(splitLines(files.base), splitLines(files.ours), splitLines(files.theirs), ['ours', 'theirs'])
        expect(Buffer.concat(marked.map((l) => Buffer.from(l))).toString('latin1'), `round ${round}`).toBe(result.stdout.toString('latin1'))
      }
    }
    expect(clean).toBeGreaterThan(50)
  }, 60_000)
})
