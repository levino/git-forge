import { describe, expect, it } from 'vitest'
import { copyObjects, copyVerified, memoryLedger, verifyEntries } from '../src/backup.ts'
import { readAll, utf8 } from '../src/bytes.ts'
import { javascriptDigests } from '../src/digest.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import type { Storage } from '../src/storage.ts'

const options = (after = '', maxBytes = Number.POSITIVE_INFINITY, maxKeys = Number.POSITIVE_INFINITY) => ({
  after,
  skip: (key: string) => key.startsWith('tmp/'),
  rewritten: (key: string) => `backups/changed/2/${key}`,
  budget: { maxBytes, maxKeys },
  digests: javascriptDigests,
})

const put = (storage: Storage, key: string, text: string) => storage.put(key, utf8(text), utf8(text).length)

const read = async (storage: Storage, key: string) => {
  const object = await storage.get(key)
  return object ? new TextDecoder().decode(await readAll(object.body)) : null
}

const keys = async (storage: Storage) => {
  const found: string[] = []
  for await (const info of storage.list('')) found.push(info.key)
  return found
}

class LockedStorage extends MemoryStorage {
  override async put(...args: Parameters<MemoryStorage['put']>) {
    if (await this.head(args[0])) throw new Error(`${args[0]} is locked`)
    return super.put(...args)
  }
}

const seed = async () => {
  const source = new MemoryStorage()
  for (let i = 0; i < 120; i++) await put(source, `repos/a/r${String(i).padStart(3, '0')}/git/objects/pack/pack-${i}.pack`, `pack ${i}`.repeat(i + 1))
  await put(source, 'repos/a/r000/git/refs.json', '{"v":1}')
  await put(source, 'tmp/repos/a/r000/x/0', 'staging')
  return source
}

describe('backup copy', () => {
  it('copies every object except tmp/ byte for byte and records its SHA-256', async () => {
    const source = await seed()
    const target = new MemoryStorage()
    const ledger = memoryLedger()
    const progress = await copyObjects(source, target, ledger, options())
    expect(progress).toMatchObject({ cursor: null, objects: 121 })
    expect(await keys(target)).toEqual((await keys(source)).filter((key) => !key.startsWith('tmp/')))
    expect(await read(target, 'repos/a/r007/git/objects/pack/pack-7.pack')).toBe('pack 7'.repeat(8))
    expect(await verifyEntries(target, [...ledger.entries.values()], javascriptDigests)).toEqual([])
  })

  it('works in bounded, resumable steps and copies only new or rewritten objects afterwards', async () => {
    const source = await seed()
    const target = new LockedStorage()
    const ledger = memoryLedger()
    let after = ''
    let steps = 0
    for (;;) {
      const progress = await copyObjects(source, target, ledger, options(after, 400, 30))
      steps++
      if (progress.cursor === null) break
      expect(progress.cursor > after).toBe(true)
      after = progress.cursor
    }
    expect(steps).toBeGreaterThan(5)
    expect(ledger.entries.size).toBe(121)
    await put(source, 'repos/a/r000/git/refs.json', '{"v":2}')
    await put(source, 'repos/b/new/git/HEAD', 'ref: refs/heads/main\n')
    const again = await copyObjects(source, target, ledger, options())
    expect(again).toMatchObject({ cursor: null, objects: 2 })
    expect(await read(target, 'repos/a/r000/git/refs.json')).toBe('{"v":1}')
    expect(await read(target, 'backups/changed/2/repos/a/r000/git/refs.json')).toBe('{"v":2}')
    expect(await copyObjects(source, target, memoryLedger(), options())).toMatchObject({ cursor: null, objects: 122 })
  })

  it('fails when the copy does not read back identically and verify reports damaged copies', async () => {
    const source = await seed()
    const broken: Storage = Object.assign(new MemoryStorage(), {
      put: async (key: string, _body: unknown, size: number) => {
        await MemoryStorage.prototype.put.call(broken, key, new Uint8Array(size), size)
        return { ok: true as const, info: { key, size, etag: 'x' } }
      },
    })
    await expect(copyVerified(source, broken, 'repos/a/r001/git/objects/pack/pack-1.pack', 'copy', javascriptDigests)).rejects.toThrow('does not match')
    const target = new MemoryStorage()
    const ledger = memoryLedger()
    await copyObjects(source, target, ledger, options())
    const entries = [...ledger.entries.values()].slice(0, 3)
    await put(target, entries[1]!.key, 'tampered')
    expect(await verifyEntries(target, [...entries, { key: 'repos/none', target: 'repos/none', etag: '', size: 1, sha256: '' }], javascriptDigests)).toEqual([
      `${entries[1]!.key}: size 8, expected ${entries[1]!.size}`,
      'repos/none: missing',
    ])
  })
})
