import { describe, expect, it } from 'vitest'
import { sha256Hex, ZERO_ID } from '../src/hash.ts'
import { type GitHttpOptions, handleGitRequest } from '../src/http.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { DEFAULT_UPLOAD_LIMITS, isUploadId, parseFinalizeRequest, parseUploadParts, receiveRequest, UploadError } from '../src/pack-upload.ts'
import { concat, readAll } from '../src/bytes.ts'
import { FLUSH, pkt } from '../src/pktline.ts'
import { createRepository, readRefs } from '../src/repository.ts'
import type { PresignedPut } from '../src/storage.ts'
import { git, gitBytes, initRepo, sampleHistory } from './git-helpers.ts'

const repo = { owner: 'acme', name: 'site' }
const base = 'https://forge.test/acme/site.git/forge/uploads'

const setup = async (options: Partial<GitHttpOptions> = {}, storage = new MemoryStorage()) => {
  await createRepository(storage, repo)
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit = { method, headers: { ...headers } }
    if (body instanceof Uint8Array) {
      init.body = body as Uint8Array<ArrayBuffer>
      ;(init.headers as Record<string, string>)['Content-Length'] = String(body.length)
    } else if (body !== undefined) init.body = JSON.stringify(body)
    const response = await handleGitRequest(new Request(`${base}${path}`, init), { storage, ...options })
    if (!response) throw new Error(`no route for ${path}`)
    const text = await response.text()
    return { status: response.status, body: (text.startsWith('{') ? JSON.parse(text) : { text }) as Record<string, any> }
  }
  return { storage, call }
}

const split = (bytes: Uint8Array, size: number): Uint8Array[] => {
  const parts: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += size) parts.push(bytes.subarray(offset, offset + size))
  return parts
}

const localPack = () => {
  const dir = initRepo()
  const ids = sampleHistory(dir, 4)
  const tip = ids[ids.length - 1] as string
  return { dir, tip, pack: gitBytes(dir, ['pack-objects', '--revs', '--stdout', '-q'], `${tip}\n`) }
}

describe('upload sessions', () => {
  it('validates parts and finalize requests', () => {
    expect(() => parseUploadParts({ parts: [{ size: 0, sha256: 'a'.repeat(64) }] }, DEFAULT_UPLOAD_LIMITS)).toThrow(UploadError)
    expect(() => parseUploadParts({ parts: [{ size: 10, sha256: 'A'.repeat(64) }] }, DEFAULT_UPLOAD_LIMITS)).toThrow(/sha256/)
    expect(() => parseUploadParts({ parts: [{ size: 11, sha256: 'a'.repeat(64) }] }, { ...DEFAULT_UPLOAD_LIMITS, maxPartBytes: 10 })).toThrow(/exceeds/)
    expect(() => parseUploadParts({ parts: [{ size: 6, sha256: 'a'.repeat(64) }, { size: 6, sha256: 'b'.repeat(64) }] }, { ...DEFAULT_UPLOAD_LIMITS, maxUploadBytes: 10 })).toThrow(
      /upload exceeds/,
    )
    expect(parseUploadParts({ parts: [] }, DEFAULT_UPLOAD_LIMITS)).toEqual([])
    expect(() => parseFinalizeRequest({ commands: [] })).toThrow(/non-empty/)
    expect(() => parseFinalizeRequest({ commands: [{ name: 'refs/heads/a', oldId: ZERO_ID, newId: ZERO_ID }] })).toThrow(/nothing to do/)
    const id = '1'.repeat(40)
    expect(() => parseFinalizeRequest({ commands: [{ name: 'refs/heads/a', oldId: ZERO_ID, newId: id }, { name: 'refs/heads/a', oldId: ZERO_ID, newId: id }] })).toThrow(/duplicate/)
    expect(parseFinalizeRequest({ commands: [{ name: 'refs/heads/a', oldId: ZERO_ID, newId: id }], atomic: true })).toEqual({
      commands: [{ name: 'refs/heads/a', oldId: ZERO_ID, newId: id }],
      atomic: true,
    })
    expect(isUploadId('../../etc')).toBe(false)
    expect(isUploadId('2026-10-18T12-00-00-000Z-0b5b7c38-8a43-4a52-9c1e-6a3d9b0f1e2d')).toBe(true)
  })

  it('frames ref commands like a receive-pack request', async () => {
    const id = '1'.repeat(40)
    const bytes = await readAll(receiveRequest({ commands: [{ name: 'refs/heads/main', oldId: ZERO_ID, newId: id }], atomic: true }, null))
    expect(bytes).toEqual(concat([pkt(`${ZERO_ID} ${id} refs/heads/main\0report-status atomic\n`), FLUSH]))
  })

  it('uploads parts through the function, resumes, and finalizes into refs', async () => {
    const { pack, tip } = localPack()
    const pushes: string[] = []
    const { storage, call } = await setup({
      maxPushBytes: 1024,
      onPush: async (_, outcome) => void pushes.push(...outcome.results.map((result) => `${result.name} ${result.ok}`)),
    })
    const info = await call('GET', '')
    expect(info.body).toMatchObject({ maxPartBytes: 1024, direct: false })
    const chunks = split(pack, 1024)
    expect(chunks.length).toBeGreaterThan(2)
    const created = await call('POST', '', { parts: chunks.map((chunk) => ({ size: chunk.length, sha256: sha256Hex(chunk) })) })
    expect(created.status).toBe(201)
    const id = created.body.id as string
    expect(created.body.parts[0].upload.href).toBe(`${base}/${id}/parts/1`)

    const wrong = await call('PUT', `/${id}/parts/1`, chunks[1]!.length === chunks[0]!.length ? chunks[1] : new Uint8Array(chunks[0]!.length))
    expect(wrong.status).toBe(422)
    expect((await call('PUT', `/${id}/parts/1`, chunks[0])).status).toBe(201)
    expect((await call('PUT', `/${id}/parts/1`, chunks[0])).status).toBe(200)

    const early = await call('POST', `/${id}/finalize`, { commands: [{ name: 'refs/heads/main', oldId: ZERO_ID, newId: tip }] })
    expect(early.status).toBe(409)
    expect(early.body.missing).toEqual(chunks.slice(1).map((_, i) => i + 2))

    const status = await call('GET', `/${id}`)
    expect(status.body.parts.map((part: { uploaded: boolean }) => part.uploaded)).toEqual(chunks.map((_, i) => i === 0))
    for (const [i, chunk] of chunks.entries()) if (i > 0) expect((await call('PUT', `/${id}/parts/${i + 1}`, chunk)).status).toBe(201)

    const done = await call('POST', `/${id}/finalize`, { commands: [{ name: 'refs/heads/main', oldId: ZERO_ID, newId: tip }] })
    expect(done.status).toBe(200)
    expect(done.body).toEqual({ unpack: 'ok', results: [{ name: 'refs/heads/main', ok: true }] })
    expect((await readRefs(storage, repo))?.state.refs['refs/heads/main']).toBe(tip)
    expect(pushes).toEqual(['refs/heads/main true'])

    const again = await call('POST', `/${id}/finalize`, { commands: [{ name: 'refs/heads/main', oldId: ZERO_ID, newId: tip }] })
    expect(again.body.results).toEqual([{ name: 'refs/heads/main', ok: false, reason: 'stale info' }])
  })

  it('applies the push policy and rejects expired sessions', async () => {
    const { pack, tip } = localPack()
    let now = new Date('2026-10-18T12:00:00Z')
    const { call } = await setup({
      receive: { policy: (command) => (command.name === 'refs/heads/main' ? 'protected branch' : null), now: () => now },
      uploads: { lifetimeSeconds: 60 },
    })
    const created = await call('POST', '', { parts: [{ size: pack.length, sha256: sha256Hex(pack) }] })
    const id = created.body.id as string
    expect((await call('PUT', `/${id}/parts/1`, pack)).status).toBe(201)
    const result = await call('POST', `/${id}/finalize`, {
      commands: [
        { name: 'refs/heads/main', oldId: ZERO_ID, newId: tip },
        { name: 'refs/heads/topic', oldId: ZERO_ID, newId: tip },
      ],
    })
    expect(result.body.results).toEqual([
      { name: 'refs/heads/main', ok: false, reason: 'protected branch' },
      { name: 'refs/heads/topic', ok: true },
    ])
    now = new Date('2026-10-18T12:01:00Z')
    expect((await call('GET', `/${id}`)).status).toBe(410)
  })

  it('hands out presigned part URLs when the storage can sign', async () => {
    const storage = new MemoryStorage() as MemoryStorage & { presignPut: (key: string, size: number, sha: string, expires: number) => Promise<PresignedPut> }
    storage.presignPut = async (key, size, sha, expires) => ({
      url: `https://bucket.test/${key}`,
      headers: { 'content-length': String(size), 'x-amz-checksum-sha256': sha },
      expiresAt: new Date(Date.now() + expires * 1000),
    })
    const { call } = await setup({}, storage)
    expect((await call('GET', '')).body.direct).toBe(true)
    const created = await call('POST', '', { parts: [{ size: 3, sha256: sha256Hex(new Uint8Array([1, 2, 3])) }] })
    expect(created.body.parts[0].upload.href).toBe(`https://bucket.test/tmp/repos/acme/site/${created.body.id}/part/00001`)
    expect(created.body.parts[0].upload.header['content-length']).toBe('3')
  })

  it('requires write access for every call', async () => {
    const { call } = await setup({ authorize: async (_, __, access) => (access === 'write' ? new Response('denied', { status: 403 }) : null) })
    const response = await handleGitRequest(new Request(`${base}`, { method: 'GET' }), {
      storage: new MemoryStorage(),
      authorize: async () => new Response('{"message":"denied"}', { status: 401 }),
    })
    expect(response?.status).toBe(401)
    expect((await call('POST', '', { parts: [] })).status).toBe(403)
  })
})

describe('upload sessions with real git objects', () => {
  it('finalizes a thin pack against existing history', async () => {
    const { dir, tip, pack } = localPack()
    const { storage, call } = await setup()
    const created = await call('POST', '', { parts: [{ size: pack.length, sha256: sha256Hex(pack) }] })
    await call('PUT', `/${created.body.id}/parts/1`, pack)
    await call('POST', `/${created.body.id}/finalize`, { commands: [{ name: 'refs/heads/main', oldId: ZERO_ID, newId: tip }] })
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'next'])
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'and next'])
    const next = git(dir, ['rev-parse', 'HEAD']).trim()
    const thin = gitBytes(dir, ['pack-objects', '--revs', '--stdout', '--thin', '-q'], `${next}\n^${tip}\n`)
    const second = await call('POST', '', { parts: [{ size: thin.length, sha256: sha256Hex(thin) }] })
    await call('PUT', `/${second.body.id}/parts/1`, thin)
    const done = await call('POST', `/${second.body.id}/finalize`, { commands: [{ name: 'refs/heads/main', oldId: tip, newId: next }] })
    expect(done.body.results).toEqual([{ name: 'refs/heads/main', ok: true }])
    expect((await readRefs(storage, repo))?.state.refs['refs/heads/main']).toBe(next)
  })
})
