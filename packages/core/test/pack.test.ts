import { writeFileSync } from 'node:fs'
import { deflate } from 'pako'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { equalBytes, toHex } from '../src/bytes.ts'
import { hashObject } from '../src/hash.ts'
import type { GitObject, ObjectType } from '../src/objects.ts'
import { PackError, parsePack, writePack } from '../src/pack.ts'
import { PackIndex, writeIndex } from '../src/pack-index.ts'
import { applyDelta } from '../src/delta.ts'
import { inflateAt } from '../src/zlib.ts'
import { git, gitBytes, initRepo, sampleHistory, tempDir } from './git-helpers.ts'

const noExternal = async () => null

const readObject = (dir: string, id: string): GitObject => ({
  type: git(dir, ['cat-file', '-t', id]).trim() as ObjectType,
  data: gitBytes(dir, ['cat-file', git(dir, ['cat-file', '-t', id]).trim(), id]),
})

describe('parsePack', () => {
  it('resolves every object of a git-generated pack with deltas', async () => {
    const dir = initRepo()
    sampleHistory(dir, 8)
    const expected = git(dir, ['rev-list', '--objects', '--all'])
      .trim()
      .split('\n')
      .map((line) => line.split(' ')[0] as string)
    const pack = gitBytes(dir, ['pack-objects', '--stdout', '--delta-base-offset', '--window=50'], `${expected.join('\n')}\n`)
    const parsed = await parsePack(pack, noExternal)
    expect(parsed.objects.map((object) => object.id).sort()).toEqual([...expected].sort())
    for (const object of parsed.objects) {
      expect(hashObject(object.type, object.data)).toBe(object.id)
      expect(equalBytes(object.data, readObject(dir, object.id).data)).toBe(true)
    }
    expect(parsed.externalBases).toEqual([])
  })

  it('handles ref-deltas without offsets', async () => {
    const dir = initRepo()
    sampleHistory(dir, 6)
    const objects = git(dir, ['rev-list', '--objects', '--all']).trim()
    const pack = gitBytes(dir, ['pack-objects', '--stdout', '--window=50'], `${objects}\n`)
    const parsed = await parsePack(pack, noExternal)
    expect(parsed.objects.length).toBe(objects.split('\n').length)
  })

  it('resolves thin packs through the external lookup', async () => {
    const dir = initRepo()
    const ids = sampleHistory(dir, 6)
    const first = ids[2] as string
    const third = ids[5] as string
    const thin = gitBytes(dir, ['pack-objects', '--stdout', '--thin', '--revs'], `${third}\n^${first}\n`)
    const asked: string[] = []
    const parsed = await parsePack(thin, async (id) => {
      asked.push(id)
      return readObject(dir, id)
    })
    expect(parsed.externalBases.length).toBeGreaterThan(0)
    expect(parsed.externalBases.every((id) => asked.includes(id))).toBe(true)
    for (const object of parsed.objects) expect(hashObject(object.type, object.data)).toBe(object.id)
  })

  it('rejects a corrupted checksum', async () => {
    const dir = initRepo()
    sampleHistory(dir, 1)
    const pack = gitBytes(dir, ['pack-objects', '--stdout', '--revs'], 'HEAD\n')
    pack[pack.length - 1] = ((pack[pack.length - 1] as number) + 1) % 256
    await expect(parsePack(pack, noExternal)).rejects.toBeInstanceOf(PackError)
  })

  it('rejects an unresolvable delta base', async () => {
    const dir = initRepo()
    const ids = sampleHistory(dir, 6)
    const first = ids[2] as string
    const third = ids[5] as string
    const thin = gitBytes(dir, ['pack-objects', '--stdout', '--thin', '--revs'], `${third}\n^${first}\n`)
    await expect(parsePack(thin, noExternal)).rejects.toBeInstanceOf(PackError)
  })
})

describe('writeIndex', () => {
  it('produces the same index bytes as git index-pack', async () => {
    const dir = initRepo()
    sampleHistory(dir, 6)
    const pack = gitBytes(dir, ['pack-objects', '--stdout', '--delta-base-offset', '--revs', '--all'], '')
    const parsed = await parsePack(pack, noExternal)
    const index = writeIndex(parsed.objects, parsed.checksum)
    const out = tempDir()
    const packPath = join(out, 'test.pack')
    gitBytes(out, ['init', '-q'])
    writeFileSync(packPath, pack)
    git(out, ['index-pack', packPath])
    const gitIndex = new Uint8Array(readFileSync(join(out, 'test.idx')))
    expect(toHex(index)).toBe(toHex(gitIndex))
    const reader = new PackIndex(index)
    expect(reader.count).toBe(parsed.objects.length)
    for (const object of parsed.objects) expect(reader.find(object.id)).toBe(object.offset)
    expect(reader.find('0'.repeat(40))).toBeNull()
  })
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
    const reparsed = await parsePack(written.bytes, noExternal)
    expect(reparsed.objects.map((object) => object.id).sort()).toEqual([...ids].sort())
    expect(toHex(writeIndex(written.objects, written.checksum))).toBe(toHex(new Uint8Array(readFileSync(join(out, 'w.idx')))))
  })

  it('handles empty blobs and large objects', async () => {
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31) % 251)
    const written = writePack([
      { type: 'blob', data: new Uint8Array(0) },
      { type: 'blob', data: big },
    ])
    const reparsed = await parsePack(written.bytes, noExternal)
    expect(reparsed.objects[0]?.data.length).toBe(0)
    expect(equalBytes(reparsed.objects[1]?.data as Uint8Array, big)).toBe(true)
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
