import { javascriptDigests, toHex } from '@git-forge/core'
import { describe, expect, it } from 'vitest'
import { digestStreams } from '../src/digest-stream.ts'

const digestOf = async (factory: typeof javascriptDigests, algorithm: 'SHA-1' | 'SHA-256', chunks: readonly Uint8Array[]) => {
  const hash = factory(algorithm)
  for (const chunk of chunks) hash.update(chunk)
  return toHex(await hash.digest())
}

describe('crypto.DigestStream adapter', () => {
  it('hashes streamed chunks like the JavaScript implementation', async () => {
    const data = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => (i * 131) & 0xff)
    const chunks = Array.from({ length: Math.ceil(data.length / 65_536) }, (_, i) => data.subarray(i * 65_536, (i + 1) * 65_536))
    for (const algorithm of ['SHA-1', 'SHA-256'] as const) {
      expect(await digestOf(digestStreams, algorithm, chunks)).toBe(await digestOf(javascriptDigests, algorithm, [data]))
    }
    expect(await digestOf(digestStreams, 'SHA-1', [])).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
  })
})
