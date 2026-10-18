import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { equalBytes, readAll, toHex } from '../src/bytes.ts'
import { ByteCursor } from '../src/cursor.ts'
import { hashObject } from '../src/hash.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import type { GitObject, ObjectType } from '../src/objects.ts'
import { PackError } from '../src/pack.ts'
import { indexPack, type ObjectLookup } from '../src/pack-indexer.ts'
import { createRepository, ObjectDatabase, packKey } from '../src/repository.ts'
import { git, gitBytes, initRepo, sampleHistory, tempDir, writeFile, commitAll } from './git-helpers.ts'

const chunked = (bytes: Uint8Array, size: number): ReadableStream<Uint8Array> => {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) controller.close()
      else {
        controller.enqueue(bytes.slice(offset, offset + size))
        offset += size
      }
    },
  })
}

const readObject = (dir: string, id: string): GitObject => {
  const type = git(dir, ['cat-file', '-t', id]).trim() as ObjectType
  return { type, data: gitBytes(dir, ['cat-file', type, id]) }
}

const nothing: ObjectLookup = { read: async () => null, has: async () => false }

const fromRepo = (dir: string): ObjectLookup & { asked: string[] } => {
  const asked: string[] = []
  return {
    asked,
    read: async (id) => {
      asked.push(id)
      try {
        return readObject(dir, id)
      } catch {
        return null
      }
    },
    has: async (id) => {
      try {
        git(dir, ['cat-file', '-e', id])
        return true
      } catch {
        return false
      }
    },
  }
}

const repo = { owner: 'test', name: 'indexer' }

const bigHistory = (dir: string): void => {
  for (let i = 0; i < 6; i++) {
    for (let f = 0; f < 4; f++) {
      const lines = Array.from({ length: 4000 }, (_, n) => `file ${f} line ${n} ${(n * 7919 + f) % 10007} ${n % 50 === i ? 'changed' : ''}`)
      writeFile(dir, `big/${f}.txt`, lines.join('\n'))
    }
    commitAll(dir, `big ${i}`)
  }
}

const index = (pack: Uint8Array, objects: ObjectLookup, options: { memoryBudget?: number; chunkSize?: number; piece?: number } = {}) => {
  const storage = new MemoryStorage()
  return {
    storage,
    indexed: indexPack(new ByteCursor(chunked(pack, options.piece ?? 4093)), {
      storage,
      stagingPrefix: 'tmp/test/',
      objects,
      ...(options.memoryBudget ? { memoryBudget: options.memoryBudget } : {}),
      ...(options.chunkSize ? { chunkSize: options.chunkSize } : {}),
    }),
  }
}

describe('indexPack', () => {
  it('indexes a git pack with deltas through staging chunks and a tiny cache, byte-identical to git index-pack', async () => {
    const dir = initRepo()
    sampleHistory(dir, 8)
    bigHistory(dir)
    const pack = gitBytes(dir, ['pack-objects', '--stdout', '--delta-base-offset', '--window=50', '--revs', '--all'], '')
    const expected = git(dir, ['rev-list', '--objects', '--all']).trim().split('\n').map((line) => line.split(' ')[0] as string)
    const { storage, indexed } = index(pack, nothing, { memoryBudget: 64 * 1024, chunkSize: 32 * 1024 })
    const result = await indexed
    expect(result.objectCount).toBe(expected.length)
    expect(result.deferred).toBeGreaterThan(0)
    const staged = []
    for await (const info of storage.list('tmp/test/')) staged.push(info.key)
    expect(staged.length).toBeGreaterThan(2)
    for (const id of expected.slice(0, 50)) {
      const object = await result.read(id)
      expect(object && hashObject(object.type, object.data)).toBe(id)
    }
    const name = await result.finalize(storage, (file) => `out/${file}`)
    expect(name).toBe(`pack-${toHex(pack.subarray(pack.length - 20))}.pack`)
    const stored = await storage.get(`out/${name}`)
    expect(equalBytes(await readAll((stored as { body: ReadableStream<Uint8Array> }).body), pack)).toBe(true)
    const out = tempDir()
    git(out, ['init', '-q'])
    writeFileSync(join(out, 'test.pack'), pack)
    git(out, ['index-pack', join(out, 'test.pack')])
    const ours = await storage.get(`out/${(name as string).replace('.pack', '.idx')}`)
    expect(toHex(await readAll((ours as { body: ReadableStream<Uint8Array> }).body))).toBe(toHex(new Uint8Array(readFileSync(join(out, 'test.idx')))))
  })

  it('handles ref-deltas and single-byte stream chunks', async () => {
    const dir = initRepo()
    sampleHistory(dir, 4)
    const pack = gitBytes(dir, ['pack-objects', '--stdout', '--window=50', '--revs', '--all'], '')
    const { indexed } = index(pack, nothing, { piece: 1, memoryBudget: 16 * 1024 })
    const result = await indexed
    expect(result.objectCount).toBe(git(dir, ['rev-list', '--objects', '--all']).trim().split('\n').length)
  })

  it('completes thin packs with the missing bases so git accepts the stored pack', async () => {
    const dir = initRepo()
    const ids = sampleHistory(dir, 6)
    bigHistory(dir)
    const thin = gitBytes(dir, ['pack-objects', '--stdout', '--thin', '--revs'], `HEAD\n^${ids[2]}\n`)
    const lookup = fromRepo(dir)
    const { storage, indexed } = index(thin, lookup, { memoryBudget: 64 * 1024, chunkSize: 16 * 1024 })
    const result = await indexed
    expect(result.thinBases).toBeGreaterThan(0)
    const name = (await result.finalize(storage, (file) => `out/${file}`)) as string
    const out = tempDir()
    git(out, ['init', '-q'])
    const packFile = await storage.get(`out/${name}`)
    const idxFile = await storage.get(`out/${name.replace('.pack', '.idx')}`)
    writeFileSync(join(out, 'thin.pack'), await readAll((packFile as { body: ReadableStream<Uint8Array> }).body))
    git(out, ['index-pack', join(out, 'thin.pack')])
    expect(git(out, ['verify-pack', join(out, 'thin.idx')])).toBe('')
    expect(toHex(await readAll((idxFile as { body: ReadableStream<Uint8Array> }).body))).toBe(toHex(new Uint8Array(readFileSync(join(out, 'thin.idx')))))
    expect(name).toBe(`pack-${git(out, ['index-pack', '--stdin'], { input: readFileSync(join(out, 'thin.pack')) }).trim().split(/\s/).pop()}.pack`)
  })

  it('rejects corrupted packs, unresolvable bases and dangling references', async () => {
    const dir = initRepo()
    const ids = sampleHistory(dir, 6)
    const pack = gitBytes(dir, ['pack-objects', '--stdout', '--revs'], 'HEAD\n')
    const corrupted = pack.slice()
    corrupted[corrupted.length - 1] = ((corrupted[corrupted.length - 1] as number) + 1) % 256
    await expect(index(corrupted, nothing).indexed).rejects.toBeInstanceOf(PackError)
    await expect(index(pack.subarray(0, pack.length - 100), nothing).indexed).rejects.toBeInstanceOf(PackError)
    const thin = gitBytes(dir, ['pack-objects', '--stdout', '--thin', '--revs'], `HEAD\n^${ids[2]}\n`)
    await expect(index(thin, nothing).indexed).rejects.toThrow(/unresolvable delta base/)
    const incomplete = gitBytes(dir, ['pack-objects', '--stdout', '--revs'], `HEAD\n^${ids[2]}\n`)
    await expect(index(incomplete, nothing).indexed).rejects.toThrow(/missing object/)
    await expect(index(incomplete, fromRepo(dir)).indexed).resolves.toBeTruthy()
  })
})

describe('ObjectDatabase', () => {
  it('reads objects through range reads and ingests streams', async () => {
    const dir = initRepo()
    sampleHistory(dir, 5)
    const storage = new MemoryStorage()
    await createRepository(storage, repo)
    const odb = new ObjectDatabase(storage, repo, { blockSize: 512, blockCacheBytes: 4096, cacheBytes: 4096 })
    const pack = gitBytes(dir, ['pack-objects', '--stdout', '--delta-base-offset', '--revs', '--all'], '')
    const { name } = await odb.ingest(chunked(pack, 1000), { memoryBudget: 8 * 1024, chunkSize: 4096 })
    expect(await odb.packNames()).toEqual([name])
    expect(await storage.head(packKey(repo, name as string))).toMatchObject({ size: pack.length })
    for (const id of git(dir, ['rev-list', '--objects', '--all']).trim().split('\n').map((line) => line.split(' ')[0] as string)) {
      const object = await new ObjectDatabase(storage, repo).read(id)
      expect(object && hashObject(object.type, object.data)).toBe(id)
      expect(object && equalBytes(object.data, readObject(dir, id).data)).toBe(true)
    }
  })
})
