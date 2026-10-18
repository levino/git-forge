import { describe, expect, it } from 'vitest'
import { CommitTooLargeError, type GitOps, planChunks, REQUEST_OVERHEAD } from '../src/plan.ts'
import { chunkRefPrefix, parseRefspec, qualifyDestination } from '../src/refspec.ts'
import { formatSize, parseSize } from '../src/size.ts'

describe('sizes', () => {
  it('parses decimal and binary units', () => {
    expect(parseSize('80MB')).toBe(80_000_000)
    expect(parseSize('80M')).toBe(80_000_000)
    expect(parseSize('16MiB')).toBe(16 * 1024 * 1024)
    expect(parseSize('1.5k')).toBe(1500)
    expect(parseSize('123')).toBe(123)
    expect(() => parseSize('0')).toThrow()
    expect(() => parseSize('ten')).toThrow()
    expect(() => parseSize('5 parsecs')).toThrow()
    expect(formatSize(80_000_000)).toBe('80.0 MB')
  })
})

describe('refspecs', () => {
  it('parses force, source and destination', () => {
    expect(parseRefspec('main')).toEqual({ force: false, src: 'main', dst: null })
    expect(parseRefspec('+HEAD:refs/heads/x')).toEqual({ force: true, src: 'HEAD', dst: 'refs/heads/x' })
    expect(() => parseRefspec(':refs/heads/x')).toThrow(/deleting/)
  })

  it('qualifies short destinations like git push', () => {
    const remote = new Map([['refs/tags/v1', 'a']])
    expect(qualifyDestination('refs/heads/x', null, remote)).toBe('refs/heads/x')
    expect(qualifyDestination('v1', 'refs/heads/v1', remote)).toBe('refs/tags/v1')
    expect(qualifyDestination('v2', 'refs/tags/v2', remote)).toBe('refs/tags/v2')
    expect(qualifyDestination('main', null, remote)).toBe('refs/heads/main')
    expect(chunkRefPrefix('refs/heads/main')).toBe('refs/forge-chunk/heads/main/')
  })
})

const linearOps = (sizes: readonly number[], estimateFactor = 1): GitOps => {
  const ids = sizes.map((_, i) => `c${i}`)
  const index = (id: string) => ids.indexOf(id)
  const covered = (negatives: readonly string[]) => Math.max(-1, ...negatives.map(index))
  const between = (tip: string, negatives: readonly string[]) => sizes.slice(covered(negatives) + 1, index(tip) + 1).reduce((a, b) => a + b, 0)
  return {
    firstParentLine: async (tip, negatives) => ids.slice(covered(negatives) + 1, index(tip) + 1),
    parents: async (id) => (index(id) > 0 ? [ids[index(id) - 1] as string] : []),
    covered: async (id, negatives) => index(id) <= covered(negatives),
    estimate: async (tip, negatives) => between(tip, negatives) * estimateFactor,
    packSize: async (tip, negatives, limit) => Math.min(between(tip, negatives), limit + 1),
  }
}

const plan = async (ops: GitOps, tip: string, budget: number) => {
  const chunks = []
  for await (const chunk of planChunks({ ops, budget, negatives: new Set(), sideRef: () => 'refs/side' }, tip, 'refs/heads/main')) chunks.push(chunk)
  return chunks
}

describe('planning', () => {
  const budget = 100 + REQUEST_OVERHEAD

  it('fills each chunk up to the budget', async () => {
    const chunks = await plan(linearOps([40, 40, 40, 40, 40]), 'c4', budget)
    expect(chunks.map((chunk) => [chunk.commit, chunk.bytes])).toEqual([
      ['c1', 80],
      ['c3', 80],
      ['c4', 40],
    ])
  })

  it('corrects estimates that are too low or too high', async () => {
    for (const factor of [0.25, 0.5, 3]) {
      const chunks = await plan(linearOps([30, 30, 30, 30, 30, 30, 30], factor), 'c6', budget)
      expect(chunks.map((chunk) => chunk.commit)).toEqual(['c2', 'c5', 'c6'])
    }
  })

  it('reports a commit that alone exceeds the budget', async () => {
    await expect(plan(linearOps([40, 500, 40]), 'c2', budget)).rejects.toBeInstanceOf(CommitTooLargeError)
  })
})
