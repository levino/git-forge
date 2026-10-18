import { fromHex, readAll, sha256Hex, utf8 } from '@git-forge/core'
import { describe, expect, it } from 'vitest'
import { makeS3TestStorage, s3TestConfig } from './env.ts'

const unique = (): string => `presign-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const upload = (url: string, headers: Readonly<Record<string, string>>, body: Uint8Array): Promise<Response> =>
  fetch(url, { method: 'PUT', headers, body: body as Uint8Array<ArrayBuffer> })

const base64Sha256 = (data: Uint8Array): string => btoa(String.fromCharCode(...fromHex(sha256Hex(data))))

const status = async (response: Response): Promise<number> => {
  await response.body?.cancel()
  return response.status
}

describe.skipIf(!s3TestConfig)('presigned URLs against a real server', () => {
  const content = utf8('exactly this content')
  const forged = utf8('EXACTLY this content')

  it('allows a GET through the presigned URL', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/read.txt`
    const data = utf8('presigned read')
    await storage.put(key, data, data.length)
    const response = await fetch(await storage.presignGet(key, 60))
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(data)
  })

  it('rejects a GET with a tampered signature', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/read.txt`
    await storage.put(key, utf8('x'), 1)
    const url = new URL(await storage.presignGet(key, 60))
    const signature = url.searchParams.get('X-Amz-Signature') ?? ''
    url.searchParams.set('X-Amz-Signature', `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`)
    expect(await status(await fetch(url))).toBe(403)
  })

  it('accepts exactly the announced content on a presigned PUT', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lfs-object`
    const presigned = await storage.presignPut(key, content.length, sha256Hex(content), 60)
    expect(presigned.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(await status(await upload(presigned.url, presigned.headers, content))).toBe(200)
    const object = await storage.get(key)
    expect(object && (await readAll(object.body))).toEqual(content)
  })

  it('rejects different content of the same length on a presigned PUT', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lfs-object`
    const presigned = await storage.presignPut(key, content.length, sha256Hex(content), 60)
    expect(await status(await upload(presigned.url, presigned.headers, forged))).toBeGreaterThanOrEqual(400)
    expect(await storage.head(key)).toBeNull()
  })

  it('rejects a different length on a presigned PUT', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lfs-object`
    const longer = utf8('exactly this content and more')
    const presigned = await storage.presignPut(key, content.length, sha256Hex(content), 60)
    const { 'content-length': _, ...rest } = presigned.headers
    expect(await status(await upload(presigned.url, rest, longer))).toBeGreaterThanOrEqual(400)
    expect(await storage.head(key)).toBeNull()
  })

  it('rejects a presigned PUT that omits the checksum header', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lfs-object`
    const presigned = await storage.presignPut(key, content.length, sha256Hex(content), 60)
    expect(await status(await upload(presigned.url, { 'content-length': String(forged.length) }, forged))).toBeGreaterThanOrEqual(400)
    expect(await storage.head(key)).toBeNull()
  })

  it('rejects a presigned PUT whose checksum header was replaced', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lfs-object`
    const presigned = await storage.presignPut(key, content.length, sha256Hex(content), 60)
    const swapped = { ...presigned.headers, 'x-amz-checksum-sha256': base64Sha256(forged) }
    expect(await status(await upload(presigned.url, swapped, forged))).toBeGreaterThanOrEqual(400)
    expect(await storage.head(key)).toBeNull()
  })

  it('rejects an expired presigned PUT', { timeout: 10_000 }, async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lfs-object`
    const presigned = await storage.presignPut(key, content.length, sha256Hex(content), 1)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(await status(await upload(presigned.url, presigned.headers, content))).toBeGreaterThanOrEqual(400)
    expect(await storage.head(key)).toBeNull()
  })
})
