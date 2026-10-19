import { utf8 } from '@git-forge/core'
import { describe, expect, it } from 'vitest'
import { cacheApiObjectCache } from '../src/object-cache.ts'

describe('cacheApiObjectCache', () => {
  it('stores bytes, size and etag in the Cache API', async () => {
    const cache = cacheApiObjectCache()
    expect(await cache.get('repos/a/b/git/objects/pack/x.idx')).toBeNull()
    await cache.put('repos/a/b/git/objects/pack/x.idx', { key: 'repos/a/b/git/objects/pack/x.idx', size: 42, etag: 'abc', bytes: utf8('index') })
    const hit = await cache.get('repos/a/b/git/objects/pack/x.idx')
    expect({ size: hit?.size, etag: hit?.etag, text: new TextDecoder().decode(hit?.bytes) }).toEqual({ size: 42, etag: 'abc', text: 'index' })
  })
})
