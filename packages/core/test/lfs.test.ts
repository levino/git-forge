import { describe, expect, it } from 'vitest'
import { streamOf, utf8 } from '../src/bytes.ts'
import { sha256Hex } from '../src/hash.ts'
import {
  lfsBatch,
  type LfsLinks,
  lfsObjectKey,
  lfsPushCheck,
  parseBatchRequest,
  parseLfsPointer,
  storeLfsObject,
  verifyLfsObject,
} from '../src/lfs.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import type { ResolvedObject } from '../src/pack.ts'
import type { PresignedPut } from '../src/storage.ts'

const repo = { owner: 'acme', name: 'assets' }

const content = utf8('hello large file\n')
const oid = sha256Hex(content)
const spec = { oid, size: content.length }

const pointer = (o: string, size: number) => utf8(`version https://git-lfs.github.com/spec/v1\noid sha256:${o}\nsize ${size}\n`)

const links: LfsLinks = {
  upload: async (object) => ({ href: `https://forge.test/upload/${object.oid}` }),
  download: async (object) => ({ href: `https://forge.test/download/${object.oid}` }),
  verify: async () => ({ href: 'https://forge.test/verify' }),
}

const blob = (data: Uint8Array): ResolvedObject => ({ type: 'blob', data, id: '0'.repeat(40), offset: 0, crc32: 0 })

class PresigningStorage extends MemoryStorage {
  async presignGet(key: string): Promise<string> {
    return `https://bucket.test/${key}?signed`
  }

  async presignPut(key: string, size: number, sha256: string, expiresInSeconds: number): Promise<PresignedPut> {
    return {
      url: `https://bucket.test/${key}?signed`,
      headers: { 'Content-Length': String(size), 'x-amz-checksum-sha256': sha256 },
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    }
  }
}

describe('LFS pointers', () => {
  it('parses canonical pointers', () => {
    expect(parseLfsPointer(pointer(oid, 17))).toEqual({ oid, size: 17 })
  })

  it('accepts sorted extension keys', () => {
    const text = `version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${'a'.repeat(64)}\noid sha256:${oid}\nsize 3\n`
    expect(parseLfsPointer(utf8(text))).toEqual({ oid, size: 3 })
  })

  it('accepts the legacy hawser version', () => {
    expect(parseLfsPointer(utf8(`version https://hawser.github.com/spec/v1\noid sha256:${oid}\nsize 17\n`))).toEqual({ oid, size: 17 })
  })

  it('rejects things that only look like pointers', () => {
    expect(parseLfsPointer(utf8(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 17`))).toBeNull()
    expect(parseLfsPointer(utf8(`version https://git-lfs.github.com/spec/v1\nsize 17\noid sha256:${oid}\n`))).toBeNull()
    expect(parseLfsPointer(utf8(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid.toUpperCase()}\nsize 17\n`))).toBeNull()
    expect(parseLfsPointer(utf8(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 017\n`))).toBeNull()
    expect(parseLfsPointer(utf8('just some text\n'))).toBeNull()
    expect(parseLfsPointer(new Uint8Array(2048).fill(0x0a))).toBeNull()
  })
})

describe('batch requests', () => {
  it('validates operation, hash algorithm and transfers', () => {
    expect(() => parseBatchRequest({ operation: 'delete', objects: [] })).toThrow(/operation/)
    expect(() => parseBatchRequest({ operation: 'upload', objects: [], hash_algo: 'sha512' })).toThrow(expect.objectContaining({ status: 409 }))
    expect(() => parseBatchRequest({ operation: 'upload', objects: [], transfers: ['tus'] })).toThrow(/basic/)
    expect(parseBatchRequest({ operation: 'download', objects: [spec], transfers: ['lfs-standalone-file', 'basic'] }).objects).toEqual([spec])
  })

  it('offers upload and verify actions for new objects and none for present ones', async () => {
    const storage = new MemoryStorage()
    const first = await lfsBatch(storage, repo, { operation: 'upload', objects: [spec] }, links)
    expect(first.objects[0]?.actions).toEqual({ upload: { href: `https://forge.test/upload/${oid}` }, verify: { href: 'https://forge.test/verify' } })
    await storeLfsObject(storage, repo, spec, streamOf(content))
    const second = await lfsBatch(storage, repo, { operation: 'upload', objects: [spec] }, links)
    expect(second.objects[0]).toEqual({ ...spec, authenticated: true })
  })

  it('reports per-object errors', async () => {
    const storage = new MemoryStorage()
    await storeLfsObject(storage, repo, spec, streamOf(content))
    const response = await lfsBatch(
      storage,
      repo,
      { operation: 'download', objects: [spec, { oid: 'a'.repeat(64), size: 1 }, { oid: 'nope', size: 1 }, { oid, size: 99 }] },
      links,
    )
    expect(response.objects.map((object) => object.error?.code ?? 200)).toEqual([200, 404, 422, 422])
    expect(response.objects[0]?.actions?.download?.href).toBe(`https://forge.test/download/${oid}`)
    const negative = await lfsBatch(storage, repo, { operation: 'upload', objects: [{ oid, size: -1 }] }, links)
    expect(negative.objects[0]?.error?.code).toBe(422)
  })
})

describe('storing objects', () => {
  it('stores content-addressed under the LFS prefix', async () => {
    const storage = new MemoryStorage()
    expect(await storeLfsObject(storage, repo, spec, streamOf(content))).toEqual({ ok: true, created: true })
    expect(lfsObjectKey(repo, oid)).toBe(`repos/acme/assets/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`)
    expect((await storage.head(lfsObjectKey(repo, oid)))?.size).toBe(content.length)
    expect(await storeLfsObject(storage, repo, spec, streamOf(content))).toEqual({ ok: true, created: false })
  })

  it('never stores content that does not match oid or size', async () => {
    const storage = new MemoryStorage()
    const wrong = utf8('something else!!\n')
    expect(await storeLfsObject(storage, repo, spec, streamOf(wrong))).toMatchObject({ ok: false, status: 422 })
    expect(await storeLfsObject(storage, repo, spec, streamOf(content.subarray(1)))).toMatchObject({ ok: false, status: 422 })
    expect(await storeLfsObject(storage, repo, { ...spec, size: 3 }, streamOf(content))).toMatchObject({ ok: false, status: 422 })
    expect(await storeLfsObject(storage, repo, { oid: 'x', size: 1 }, streamOf(content))).toMatchObject({ ok: false, status: 422 })
    const keys: string[] = []
    for await (const info of storage.list('repos/')) keys.push(info.key)
    expect(keys).toEqual([])
  })
})

describe('verify', () => {
  it('checks size only for objects the forge streamed itself', async () => {
    const storage = new MemoryStorage()
    expect(await verifyLfsObject(storage, repo, spec, { checkHash: false })).toMatchObject({ ok: false, status: 404 })
    await storeLfsObject(storage, repo, spec, streamOf(content))
    expect(await verifyLfsObject(storage, repo, spec, { checkHash: false })).toEqual({ ok: true })
    expect(await verifyLfsObject(storage, repo, { ...spec, size: 1 }, { checkHash: false })).toMatchObject({ ok: false, status: 422 })
  })

  it('re-hashes objects uploaded through presigned URLs', async () => {
    const storage = new PresigningStorage()
    const forged = utf8('not the content!\n')
    await storage.put(lfsObjectKey(repo, oid), forged, forged.length)
    expect(await verifyLfsObject(storage, repo, spec, { checkHash: true })).toMatchObject({ ok: false, status: 422 })
    const other = new PresigningStorage()
    await other.put(lfsObjectKey(repo, oid), content, content.length)
    expect(await verifyLfsObject(other, repo, spec, { checkHash: true })).toEqual({ ok: true })
  })
})

describe('push check', () => {
  it('rejects pushes whose pointers reference missing objects', async () => {
    const storage = new MemoryStorage()
    const check = lfsPushCheck(storage, repo)
    expect(await check([blob(pointer(oid, content.length)), blob(utf8('plain\n'))])).toBe(`missing LFS object ${oid}`)
    await storeLfsObject(storage, repo, spec, streamOf(content))
    expect(await check([blob(pointer(oid, content.length))])).toBeNull()
    expect(await check([blob(pointer(oid, 5))])).toBe(`missing LFS object ${oid}`)
    expect(await check([blob(utf8('version https://git-lfs.github.com/spec/v1\n'))])).toBeNull()
  })
})
