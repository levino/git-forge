import { ChecksumMismatchError, readAll, toHex, utf8 } from '@git-forge/core'
import { describeStorageConformance } from '@git-forge/core/test/storage-conformance.ts'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { R2Storage } from '../src/r2-storage.ts'

const bucket = (env as unknown as { BUCKET: R2Bucket }).BUCKET

let counter = 0

describeStorageConformance('R2Storage', () => new R2Storage(bucket, { prefix: `run-${++counter}/`, listPageSize: 7 }), {
  paginationKeys: 25,
})

describe('R2Storage specifics', () => {
  it('keeps keys under its prefix and strips it when listing', async () => {
    const storage = new R2Storage(bucket, { prefix: 'tenant-a/' })
    await storage.put('x/y', utf8('1'), 1)
    expect(await bucket.head('tenant-a/x/y')).not.toBeNull()
    expect(await bucket.head('x/y')).toBeNull()
    const keys = []
    for await (const entry of storage.list('x/')) keys.push(entry.key)
    expect(keys).toEqual(['x/y'])
  })

  it('stores the content type as HTTP metadata', async () => {
    const storage = new R2Storage(bucket, { prefix: 'meta/' })
    await storage.put('pack', utf8('PACK'), 4, { contentType: 'application/x-git-packed-objects' })
    const object = await bucket.get('meta/pack')
    expect(object?.httpMetadata?.contentType).toBe('application/x-git-packed-objects')
    expect(new TextDecoder().decode(await readAll((object as R2ObjectBody).body as ReadableStream<Uint8Array>))).toBe('PACK')
  })

  it('stores a verified stream only when its SHA-256 matches', async () => {
    const storage = new R2Storage(bucket, { prefix: 'verified/' })
    const body = utf8('large file')
    const sha256 = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', body)))
    const stream = () => new Blob([body]).stream() as ReadableStream<Uint8Array>
    await expect(storage.putVerified('bad', stream(), body.length, sha256.replace(/^./, sha256[0] === '0' ? '1' : '0'))).rejects.toBeInstanceOf(ChecksumMismatchError)
    expect(await bucket.head('verified/bad')).toBeNull()
    expect(await storage.putVerified('good', stream(), body.length, sha256, { ifNoneMatch: '*' })).toEqual({ ok: true, info: expect.objectContaining({ key: 'good', size: body.length }) })
  })
})
