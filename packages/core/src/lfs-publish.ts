import { isLfsOid, lfsObjectKey, lfsPrefix } from './lfs.ts'
import type { RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'

export interface LfsPublisher {
  has(oid: string, size: number): Promise<boolean>
  publish(oid: string, size: number, body: ReadableStream<Uint8Array>): Promise<void>
}

export const publishedObjectKey = (oid: string, prefix = ''): string => `${prefix}${oid}`

export const storagePublisher = (target: Storage, prefix = ''): LfsPublisher => ({
  has: async (oid, size) => (await target.head(publishedObjectKey(oid, prefix)))?.size === size,
  publish: async (oid, size, body) => {
    await target.put(publishedObjectKey(oid, prefix), body, size, { ifNoneMatch: '*', contentType: 'application/octet-stream' })
  },
})

export type PublishSummary = {
  readonly published: readonly string[]
  readonly present: readonly string[]
  readonly missing: readonly string[]
}

export const publishLfsObjects = async (storage: Storage, repo: RepositoryName, publisher: LfsPublisher, oids: readonly string[]): Promise<PublishSummary> => {
  const published: string[] = []
  const present: string[] = []
  const missing: string[] = []
  for (const oid of new Set(oids)) {
    if (!isLfsOid(oid)) continue
    const info = await storage.head(lfsObjectKey(repo, oid))
    if (!info) {
      missing.push(oid)
      continue
    }
    if (await publisher.has(oid, info.size)) {
      present.push(oid)
      continue
    }
    const object = await storage.get(lfsObjectKey(repo, oid))
    if (!object) {
      missing.push(oid)
      continue
    }
    await publisher.publish(oid, info.size, object.body)
    published.push(oid)
  }
  return { published, present, missing }
}

export async function* listLfsOids(storage: Storage, repo: RepositoryName): AsyncGenerator<string> {
  for await (const object of storage.list(`${lfsPrefix(repo)}objects/`)) {
    const oid = object.key.slice(object.key.lastIndexOf('/') + 1)
    if (isLfsOid(oid)) yield oid
  }
}
