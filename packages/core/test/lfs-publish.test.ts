import { describe, expect, it } from 'vitest'
import { listLfsOids, MemoryStorage, publishedObjectKey, publishLfsObjects, readAll, sha256Hex, storagePublisher, storeLfsObject, streamOf } from '../src/index.ts'

const repo = { owner: 'alice', name: 'photos' }

const object = (text: string) => {
  const data = new TextEncoder().encode(text)
  return { data, oid: sha256Hex(data), size: data.length }
}

describe('publishLfsObjects', () => {
  it('copies present objects into the public bucket keyed by oid, once', async () => {
    const storage = new MemoryStorage()
    const cdn = new MemoryStorage()
    const a = object('first object')
    const b = object('second object')
    const absent = object('never uploaded')
    for (const item of [a, b]) await storeLfsObject(storage, repo, { oid: item.oid, size: item.size }, streamOf(item.data))
    const publisher = storagePublisher(cdn, 'lfs/')
    const first = await publishLfsObjects(storage, repo, publisher, [a.oid, b.oid, absent.oid, a.oid, 'not-an-oid'])
    expect(first).toEqual({ published: [a.oid, b.oid], present: [], missing: [absent.oid] })
    expect(await readAll((await cdn.get(publishedObjectKey(a.oid, 'lfs/')))!.body)).toEqual(a.data)
    const second = await publishLfsObjects(storage, repo, publisher, [a.oid])
    expect(second).toEqual({ published: [], present: [a.oid], missing: [] })
    const listed: string[] = []
    for await (const oid of listLfsOids(storage, repo)) listed.push(oid)
    expect(listed.sort()).toEqual([a.oid, b.oid].sort())
  })
})
