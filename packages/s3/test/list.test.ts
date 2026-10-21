import { describe, expect, it } from 'vitest'
import { S3Storage } from '../src/index.ts'

const listing = (keys: readonly string[]) =>
  `<ListBucketResult><Name>b</Name><IsTruncated>false</IsTruncated>${keys.map((key) => `<Contents><Key>${key}</Key><Size>${key.endsWith('/') ? 0 : 1}</Size><ETag>"e"</ETag></Contents>`).join('')}</ListBucketResult>`

describe('S3Storage.list', () => {
  it('skips directory markers that some servers list (Bunny Storage)', async () => {
    const storage = new S3Storage({
      endpoint: 'https://s3.example',
      region: 'de',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
      prefix: 'x/',
      fetch: async () => new Response(listing(['x/p/a', 'x/p/c/', 'x/p/c-z', 'x/p/c/d', 'x/p/c/e/', 'x/p/c/e/f'])),
    })
    const keys: string[] = []
    for await (const info of storage.list('p/')) keys.push(info.key)
    expect(keys).toEqual(['p/a', 'p/c-z', 'p/c/d', 'p/c/e/f'])
  })
})
