import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflate } from 'pako'
import { describe, expect, it } from 'vitest'
import { equalBytes, streamOf, toHex } from '../src/bytes.ts'
import { ByteCursor } from '../src/cursor.ts'
import { applyDelta } from '../src/delta.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import type { GitObject, ObjectType } from '../src/objects.ts'
import { writePack } from '../src/pack.ts'
import { PackIndex, writeIndex } from '../src/pack-index.ts'
import { encodeOfsDistance } from '../src/pack-writer.ts'
import { readOfsDeltaOffset } from '../src/pack.ts'
import { indexPack } from '../src/pack-indexer.ts'
import { inflateAt } from '../src/zlib.ts'
import { git, gitBytes, initRepo, sampleHistory, tempDir } from './git-helpers.ts'

const reindex = (pack: Uint8Array) =>
  indexPack(new ByteCursor(streamOf(pack)), {
    storage: new MemoryStorage(),
    stagingPrefix: 'tmp/',
    objects: { read: async () => null, has: async () => false },
  })

const readObject = (dir: string, id: string): GitObject => ({
  type: git(dir, ['cat-file', '-t', id]).trim() as ObjectType,
  data: gitBytes(dir, ['cat-file', git(dir, ['cat-file', '-t', id]).trim(), id]),
})

describe('writePack', () => {
  it('writes packs that git verifies', async () => {
    const dir = initRepo()
    sampleHistory(dir, 3)
    const ids = git(dir, ['rev-list', '--objects', '--all'])
      .trim()
      .split('\n')
      .map((line) => line.split(' ')[0] as string)
    const written = writePack(ids.map((id) => readObject(dir, id)))
    const out = tempDir()
    git(out, ['init', '-q'])
    writeFileSync(join(out, 'w.pack'), written.bytes)
    git(out, ['index-pack', join(out, 'w.pack')])
    const verify = git(out, ['verify-pack', '-v', join(out, 'w.idx')])
    expect(verify).toContain(': ok')
    const reindexed = await reindex(written.bytes)
    expect(reindexed.objectCount).toBe(ids.length)
    for (const id of ids) expect(reindexed.typeOf(id)).toBe(readObject(dir, id).type)
    expect(toHex(writeIndex(written.objects, written.checksum))).toBe(toHex(new Uint8Array(readFileSync(join(out, 'w.idx')))))
    const reader = new PackIndex(new Uint8Array(readFileSync(join(out, 'w.idx'))))
    for (const object of written.objects) expect(reader.find(object.id)).toBe(object.offset)
    expect(reader.find('0'.repeat(40))).toBeNull()
  })

  it('handles empty blobs and large objects', async () => {
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31) % 251)
    const written = writePack([
      { type: 'blob', data: new Uint8Array(0) },
      { type: 'blob', data: big },
    ])
    const reindexed = await reindex(written.bytes)
    expect((await reindexed.read(written.objects[0]?.id as string))?.data.length).toBe(0)
    expect(equalBytes((await reindexed.read(written.objects[1]?.id as string))?.data as Uint8Array, big)).toBe(true)
  })
})

describe('inflateAt', () => {
  it('stops exactly at the end of one zlib stream', () => {
    const a = deflate(new Uint8Array([1, 2, 3]))
    const b = deflate(new Uint8Array([4, 5]))
    const both = new Uint8Array([...a, ...b])
    const first = inflateAt(both, 0)
    expect([...first.data]).toEqual([1, 2, 3])
    expect(first.consumed).toBe(a.length)
    expect([...inflateAt(both, first.consumed).data]).toEqual([4, 5])
  })
})

describe('applyDelta', () => {
  it('rejects deltas with wrong base size', () => {
    expect(() => applyDelta(new Uint8Array(3), new Uint8Array([5, 1, 1, 0x41]))).toThrow()
  })
})

describe('encodeOfsDistance', () => {
  it('round-trips through the ofs-delta decoder', () => {
    for (const distance of [1, 127, 128, 129, 16511, 16512, 2 ** 21, 2 ** 31 + 5, 2 ** 40 + 3]) {
      const encoded = encodeOfsDistance(distance)
      expect(readOfsDeltaOffset(encoded, 0)).toEqual({ distance, length: encoded.length })
    }
  })
})
