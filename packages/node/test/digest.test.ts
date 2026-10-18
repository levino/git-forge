import { javascriptDigests, toHex } from '@git-forge/core'
import { describe, expect, it } from 'vitest'
import { nodeDigests } from '../src/digest.ts'

const hex = async (factory: typeof nodeDigests, algorithm: 'SHA-1' | 'SHA-256', chunks: Uint8Array[]) => {
  const digest = factory(algorithm)
  for (const chunk of chunks) digest.update(chunk)
  return toHex(await digest.digest())
}

describe('nodeDigests', () => {
  it('matches the JavaScript digests chunk by chunk', async () => {
    const chunks = [new Uint8Array(0), new TextEncoder().encode('blob 3\0abc'), new Uint8Array(100_000).fill(7)]
    for (const algorithm of ['SHA-1', 'SHA-256'] as const) {
      expect(await hex(nodeDigests, algorithm, chunks)).toBe(await hex(javascriptDigests, algorithm, chunks))
    }
    expect(await hex(nodeDigests, 'SHA-256', [])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})
