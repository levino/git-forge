import { readAll, sha256Hex, utf8 } from '@git-forge/core'
import { describe, expect, it } from 'vitest'
import { makeS3TestStorage, s3TestConfig } from './env.ts'

const unique = (): string => `presign-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const upload = (url: string, headers: Readonly<Record<string, string>>, body: Uint8Array): Promise<Response> =>
  fetch(url, { method: 'PUT', headers, body: body as Uint8Array<ArrayBuffer> })

describe.skipIf(!s3TestConfig)('vorsignierte URLs gegen echten Server', () => {
  it('erlaubt einen GET über die vorsignierte URL', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lesen.txt`
    const data = utf8('vorsigniert lesen')
    await storage.put(key, data, data.length)
    const response = await fetch(await storage.presignGet(key, 60))
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(data)
  })

  it('lehnt einen GET mit verfälschter Signatur ab', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lesen.txt`
    await storage.put(key, utf8('x'), 1)
    const url = new URL(await storage.presignGet(key, 60))
    const signature = url.searchParams.get('X-Amz-Signature') ?? ''
    url.searchParams.set('X-Amz-Signature', `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`)
    const response = await fetch(url)
    await response.body?.cancel()
    expect(response.status).toBe(403)
  })

  it('nimmt beim vorsignierten PUT genau den angekündigten Inhalt an', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lfs-objekt`
    const data = utf8('genau dieser Inhalt')
    const presigned = await storage.presignPut(key, data.length, sha256Hex(data), 60)
    expect(presigned.expiresAt.getTime()).toBeGreaterThan(Date.now())
    const response = await upload(presigned.url, presigned.headers, data)
    await response.body?.cancel()
    expect(response.status).toBe(200)
    const object = await storage.get(key)
    expect(object && (await readAll(object.body))).toEqual(data)
  })

  it('lehnt beim vorsignierten PUT anderen Inhalt gleicher Länge ab', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lfs-objekt`
    const data = utf8('genau dieser Inhalt')
    const forged = utf8('GENAU dieser Inhalt')
    const presigned = await storage.presignPut(key, data.length, sha256Hex(data), 60)
    const response = await upload(presigned.url, presigned.headers, forged)
    await response.body?.cancel()
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await storage.head(key)).toBeNull()
  })

  it('lehnt beim vorsignierten PUT eine andere Länge ab', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lfs-objekt`
    const data = utf8('genau dieser Inhalt')
    const longer = utf8('genau dieser Inhalt und mehr')
    const presigned = await storage.presignPut(key, data.length, sha256Hex(data), 60)
    const { 'content-length': _, ...rest } = presigned.headers
    const response = await upload(presigned.url, rest, longer)
    await response.body?.cancel()
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await storage.head(key)).toBeNull()
  })

  it('lehnt beim vorsignierten PUT das Weglassen der Prüfsumme ab', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lfs-objekt`
    const data = utf8('genau dieser Inhalt')
    const forged = utf8('GENAU dieser Inhalt')
    const presigned = await storage.presignPut(key, data.length, sha256Hex(data), 60)
    const response = await upload(presigned.url, { 'content-length': String(forged.length) }, forged)
    await response.body?.cancel()
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await storage.head(key)).toBeNull()
  })

  it('lehnt einen abgelaufenen vorsignierten PUT ab', async () => {
    const storage = makeS3TestStorage()
    const key = `${unique()}/lfs-objekt`
    const data = utf8('abgelaufen')
    const presigned = await storage.presignPut(key, data.length, sha256Hex(data), 1)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const response = await upload(presigned.url, presigned.headers, data)
    await response.body?.cancel()
    expect(response.status).toBe(403)
    expect(await storage.head(key)).toBeNull()
  }, 10_000)
})
