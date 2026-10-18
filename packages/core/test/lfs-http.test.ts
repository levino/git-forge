import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { utf8 } from '../src/bytes.ts'
import { sha256Hex } from '../src/hash.ts'
import { type Authorize, handleGitRequest } from '../src/http.ts'
import { LFS_CONTENT_TYPE, lfsObjectKey } from '../src/lfs.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { createRepository, readRefs } from '../src/repository.ts'
import type { PresignedPut } from '../src/storage.ts'
import { gitEnv, tempDir, writeFile } from './git-helpers.ts'
import { type RunningServer, startServer } from './http-server.ts'

const run = promisify(execFile)

const lfsFilterConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
] as const

const env = {
  ...process.env,
  ...gitEnv,
  GIT_CONFIG_COUNT: String(lfsFilterConfig.length),
  ...Object.fromEntries(lfsFilterConfig.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
}

const gitAsync = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, env, maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

const gitFails = async (cwd: string, args: readonly string[]): Promise<string> => {
  try {
    await gitAsync(cwd, args)
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error)
  }
  throw new Error(`git ${args.join(' ')} unexpectedly succeeded`)
}

const WRITER = `Basic ${btoa('writer:secret')}`

const authorize: Authorize = async (request, _repo, access) => {
  if (access === 'read' || request.headers.get('Authorization') === WRITER) return null
  return new Response(JSON.stringify({ message: 'write access required' }), {
    status: 401,
    headers: { 'Content-Type': LFS_CONTENT_TYPE, 'WWW-Authenticate': 'Basic realm="git-forge"', 'LFS-Authenticate': 'Basic realm="git-forge"' },
  })
}

let storage: MemoryStorage
let server: RunningServer
let repoCounter = 0
let current = { owner: 'test', name: '' }

beforeAll(async () => {
  server = await startServer(async (request) => (await handleGitRequest(request, { storage, authorize })) ?? new Response('not found', { status: 404 }))
})

afterAll(async () => {
  await server.close()
})

beforeEach(() => {
  storage = new MemoryStorage()
})

const newRemote = async (credentials = 'writer:secret'): Promise<{ remote: string; anonymous: string; lfs: string }> => {
  current = { owner: 'test', name: `lfs${++repoCounter}` }
  await createRepository(storage, current)
  const path = `/test/${current.name}.git`
  return { remote: `${server.url.replace('://', `://${credentials}@`)}${path}`, anonymous: `${server.url}${path}`, lfs: `${server.url}${path}/info/lfs` }
}

const randomBytes = (size: number, seed: number): Uint8Array => {
  const out = new Uint8Array(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

const lfsRepo = async (remote: string): Promise<string> => {
  const dir = tempDir()
  await gitAsync(dir, ['init', '-q', '-b', 'main'])
  await gitAsync(dir, ['lfs', 'install', '--local'])
  await gitAsync(dir, ['config', 'lfs.locksverify', 'false'])
  await gitAsync(dir, ['remote', 'add', 'origin', remote])
  await gitAsync(dir, ['lfs', 'track', '*.bin'])
  return dir
}

const commit = async (dir: string, message: string) => {
  await gitAsync(dir, ['add', '-A'])
  await gitAsync(dir, ['commit', '-q', '-m', message])
}

const batch = (url: string, body: unknown, authorization?: string) =>
  fetch(`${url}/objects/batch`, {
    method: 'POST',
    headers: { Accept: LFS_CONTENT_TYPE, 'Content-Type': LFS_CONTENT_TYPE, ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(body),
  })

describe('git lfs over HTTP', () => {
  it('pushes, clones with smudge and pulls with git lfs pull', async () => {
    const { remote, anonymous } = await newRemote()
    const source = await lfsRepo(remote)
    const big = randomBytes(300_000, 1)
    const other = randomBytes(5_000, 2)
    writeFile(source, 'assets/big.bin', big)
    writeFile(source, 'assets/other.bin', other)
    writeFile(source, 'README.md', '# lfs\n')
    await commit(source, 'add binaries')
    await gitAsync(source, ['push', '-q', 'origin', 'main'])

    for (const data of [big, other]) {
      const stored = await storage.head(lfsObjectKey(current, sha256Hex(data)))
      expect(stored?.size).toBe(data.length)
    }
    const ls = await gitAsync(source, ['lfs', 'ls-files', '--long'])
    expect(ls).toContain(sha256Hex(big))

    const clone = tempDir()
    await gitAsync(clone, ['clone', '-q', anonymous, 'out'])
    expect(new Uint8Array(readFileSync(`${clone}/out/assets/big.bin`))).toEqual(big)
    expect(new Uint8Array(readFileSync(`${clone}/out/assets/other.bin`))).toEqual(other)

    const lazy = tempDir()
    await run('git', ['clone', '-q', anonymous, 'out'], { cwd: lazy, env: { ...env, GIT_LFS_SKIP_SMUDGE: '1' } })
    expect(readFileSync(`${lazy}/out/assets/big.bin`, 'utf8')).toContain('version https://git-lfs.github.com/spec/v1')
    await gitAsync(`${lazy}/out`, ['lfs', 'install', '--local'])
    await gitAsync(`${lazy}/out`, ['lfs', 'pull'])
    expect(new Uint8Array(readFileSync(`${lazy}/out/assets/big.bin`))).toEqual(big)
    expect(await gitAsync(`${lazy}/out`, ['lfs', 'fsck'])).toMatch(/ok/i)

    const batchCalls = server.requests.filter((request) => request.path.endsWith('/info/lfs/objects/batch'))
    expect(batchCalls.length).toBeGreaterThanOrEqual(3)
    expect(server.requests.some((request) => request.method === 'POST' && request.path.endsWith('/info/lfs/objects/verify'))).toBe(true)
  })

  it('only uploads objects the forge does not have yet', async () => {
    const { remote } = await newRemote()
    const source = await lfsRepo(remote)
    writeFile(source, 'a.bin', randomBytes(10_000, 3))
    await commit(source, 'a')
    await gitAsync(source, ['push', '-q', 'origin', 'main'])
    const before = server.requests.length
    writeFile(source, 'b.bin', randomBytes(10_000, 4))
    await commit(source, 'b')
    await gitAsync(source, ['push', '-q', 'origin', 'main'])
    const uploads = server.requests.slice(before).filter((request) => request.method === 'PUT')
    expect(uploads).toHaveLength(1)
  })

  it('rejects pushes that reference LFS objects the forge does not have', async () => {
    const { remote } = await newRemote()
    const source = await lfsRepo(remote)
    writeFile(source, 'missing.bin', randomBytes(20_000, 5))
    await commit(source, 'missing object')
    const stderr = await gitFails(source, ['push', '--no-verify', 'origin', 'main'])
    expect(stderr).toMatch(/missing LFS object [0-9a-f]{64}/)
    expect((await readRefs(storage, current))?.state.refs).toEqual({})

    const plain = tempDir()
    await gitAsync(plain, ['init', '-q', '-b', 'main'])
    const fake = utf8(`version https://git-lfs.github.com/spec/v1\noid sha256:${'b'.repeat(64)}\nsize 12\n`)
    writeFile(plain, 'pointer.bin', fake)
    await gitAsync(plain, ['add', '-A'])
    await gitAsync(plain, ['-c', 'filter.lfs.required=false', '-c', 'filter.lfs.clean=cat', '-c', 'filter.lfs.process=', 'commit', '-q', '-m', 'fake'])
    expect(await gitFails(plain, ['push', remote, 'main'])).toMatch(/missing LFS object b{64}/)

    await gitAsync(source, ['push', '-q', 'origin', 'main'])
    expect(Object.keys((await readRefs(storage, current))?.state.refs ?? {})).toEqual(['refs/heads/main'])
  })

  it('refuses uploads without write access', async () => {
    const { remote, lfs } = await newRemote('reader:wrong')
    const source = await lfsRepo(remote)
    writeFile(source, 'secret.bin', randomBytes(1_000, 6))
    await commit(source, 'secret')
    expect(await gitFails(source, ['lfs', 'push', '--all', 'origin'])).toMatch(/Authentication required: write access required/)
    expect(await gitFails(source, ['push', 'origin', 'main'])).toMatch(/Authentication failed/)
    const keys: string[] = []
    for await (const info of storage.list(`repos/test/${current.name}/lfs/`)) keys.push(info.key)
    expect(keys).toEqual([])

    const data = randomBytes(64, 7)
    const oid = sha256Hex(data)
    expect((await batch(lfs, { operation: 'upload', objects: [{ oid, size: 64 }] })).status).toBe(401)
    expect((await fetch(`${lfs}/objects/${oid}`, { method: 'PUT', body: data as Uint8Array<ArrayBuffer> })).status).toBe(401)
    expect((await batch(lfs, { operation: 'download', objects: [{ oid, size: 64 }] })).status).toBe(200)
  })

  it('rejects uploads whose bytes do not match oid and size', async () => {
    const { lfs } = await newRemote()
    const data = randomBytes(4096, 8)
    const oid = sha256Hex(data)
    const response = await batch(lfs, { operation: 'upload', transfers: ['basic'], objects: [{ oid, size: data.length }], hash_algo: 'sha256' }, WRITER)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(LFS_CONTENT_TYPE)
    const body = (await response.json()) as { transfer: string; objects: { actions: Record<string, { href: string; header: Record<string, string> }> }[] }
    expect(body.transfer).toBe('basic')
    const upload = body.objects[0]?.actions.upload
    const verify = body.objects[0]?.actions.verify
    if (!upload || !verify) throw new Error('missing actions')
    expect(upload.header.Authorization).toBe(WRITER)

    const put = (bytes: Uint8Array) => fetch(upload.href, { method: 'PUT', headers: upload.header, body: bytes as Uint8Array<ArrayBuffer> })
    expect((await put(data.subarray(0, 4000))).status).toBe(422)
    const tampered = data.slice()
    tampered[100] = (tampered[100] as number) ^ 0xff
    expect((await put(tampered)).status).toBe(422)
    expect(await storage.head(lfsObjectKey(current, oid))).toBeNull()

    const verifyRequest = (size: number) =>
      fetch(verify.href, { method: 'POST', headers: { ...verify.header, 'Content-Type': LFS_CONTENT_TYPE }, body: JSON.stringify({ oid, size }) })
    expect((await verifyRequest(data.length)).status).toBe(404)
    expect((await put(data)).status).toBe(200)
    expect((await verifyRequest(data.length)).status).toBe(200)
    expect((await verifyRequest(data.length + 1)).status).toBe(422)

    const download = await batch(lfs, { operation: 'download', objects: [{ oid, size: data.length }, { oid: 'c'.repeat(64), size: 1 }] })
    const result = (await download.json()) as { objects: { error?: { code: number }; actions?: { download: { href: string } } }[] }
    expect(result.objects[1]?.error?.code).toBe(404)
    const fetched = await fetch(result.objects[0]?.actions?.download.href ?? '')
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(data)
  })

  it('answers protocol errors with LFS JSON', async () => {
    const { lfs } = await newRemote()
    const sha512 = await batch(lfs, { operation: 'download', objects: [], hash_algo: 'sha512' })
    expect(sha512.status).toBe(409)
    expect(sha512.headers.get('Content-Type')).toBe(LFS_CONTENT_TYPE)
    expect((await batch(lfs, { operation: 'launch', objects: [] })).status).toBe(422)
    expect((await batch(`${server.url}/test/nothing.git/info/lfs`, { operation: 'download', objects: [] })).status).toBe(404)
    expect((await fetch(`${lfs}/objects/batch`)).status).toBe(405)
    expect((await fetch(`${lfs}/locks/verify`, { method: 'POST', body: '{}' })).status).toBe(404)
  })
})

describe('git lfs with presigning storage', () => {
  it('hands out presigned URLs bound to size and sha256', async () => {
    class PresigningStorage extends MemoryStorage {
      async presignGet(key: string, expires: number): Promise<string> {
        return `https://bucket.test/${key}?expires=${expires}`
      }

      async presignPut(key: string, size: number, sha256: string, expires: number): Promise<PresignedPut> {
        return {
          url: `https://bucket.test/${key}`,
          headers: { 'x-amz-checksum-sha256': btoa(String.fromCharCode(...(sha256.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)))), 'Content-Length': String(size) },
          expiresAt: new Date(Date.now() + expires * 1000),
        }
      }
    }
    const presigning = new PresigningStorage()
    const repo = { owner: 'test', name: 'signed' }
    await createRepository(presigning, repo)
    const oid = 'd'.repeat(64)
    const request = (body: unknown, authorization?: string) =>
      handleGitRequest(
        new Request('https://forge.test/test/signed.git/info/lfs/objects/batch', {
          method: 'POST',
          headers: { 'Content-Type': LFS_CONTENT_TYPE, ...(authorization ? { Authorization: authorization } : {}) },
          body: JSON.stringify(body),
        }),
        { storage: presigning, authorize, lfs: { expiresInSeconds: 600 } },
      )
    const upload = await request({ operation: 'upload', objects: [{ oid, size: 5 }] }, WRITER)
    const uploadBody = (await upload?.json()) as { objects: { actions: Record<string, { href: string; header?: Record<string, string>; expires_in?: number }> }[] }
    const actions = uploadBody.objects[0]?.actions
    expect(actions?.upload?.href).toBe(`https://bucket.test/${lfsObjectKey(repo, oid)}`)
    expect(actions?.upload?.header?.['Content-Length']).toBe('5')
    expect(actions?.upload?.expires_in).toBeGreaterThan(590)
    expect(actions?.verify?.href).toBe('https://forge.test/test/signed.git/info/lfs/objects/verify')
    await presigning.put(lfsObjectKey(repo, oid), utf8('hello'), 5)
    const download = await request({ operation: 'download', objects: [{ oid, size: 5 }] })
    const downloadBody = (await download?.json()) as { objects: { actions: { download: { href: string } } }[] }
    expect(downloadBody.objects[0]?.actions.download.href).toBe(`https://bucket.test/${lfsObjectKey(repo, oid)}?expires=600`)
    const verify = await handleGitRequest(
      new Request('https://forge.test/test/signed.git/info/lfs/objects/verify', {
        method: 'POST',
        headers: { Authorization: WRITER },
        body: JSON.stringify({ oid, size: 5 }),
      }),
      { storage: presigning, authorize },
    )
    expect(verify?.status).toBe(422)
  })
})

describe('authorization surface and object size limit', () => {
  const repo = { owner: 'test', name: 'limits' }
  const base = 'https://forge.example/test/limits.git'
  const oid = 'a'.repeat(64)

  it('tells the authorizer whether a request is git or LFS', async () => {
    const store = new MemoryStorage()
    await createRepository(store, repo)
    const seen: string[] = []
    const recording: Authorize = async (_request, _repo, access, surface) => {
      seen.push(`${surface}:${access}`)
      return null
    }
    const call = (path: string, init?: RequestInit) => handleGitRequest(new Request(`${base}${path}`, init), { storage: store, authorize: recording })
    await call('/info/refs?service=git-upload-pack', { headers: { 'Git-Protocol': 'version=2' } })
    await call('/info/refs?service=git-receive-pack')
    await call('/info/lfs/objects/batch', { method: 'POST', body: JSON.stringify({ operation: 'download', objects: [{ oid, size: 1 }] }) })
    await call('/info/lfs/objects/batch', { method: 'POST', body: JSON.stringify({ operation: 'upload', objects: [{ oid, size: 1 }] }) })
    await call(`/info/lfs/objects/${oid}`)
    expect(seen).toEqual(['git:read', 'git:write', 'lfs:read', 'lfs:write', 'lfs:read'])
  })

  it('refuses objects above maxObjectBytes in the batch API and on PUT', async () => {
    const store = new MemoryStorage()
    await createRepository(store, repo)
    const options = { storage: store, lfs: { maxObjectBytes: 4 } }
    const response = await handleGitRequest(
      new Request(`${base}/info/lfs/objects/batch`, {
        method: 'POST',
        body: JSON.stringify({ operation: 'upload', objects: [{ oid, size: 5 }, { oid: 'b'.repeat(64), size: 4 }] }),
      }),
      options,
    )
    const body = (await response!.json()) as { objects: { error?: { code: number; message: string }; actions?: unknown }[] }
    expect(body.objects[0]).toMatchObject({ error: { code: 422, message: 'object exceeds 4 bytes' } })
    expect(body.objects[1]!.actions).toBeDefined()
    const bytes = utf8('hello')
    const put = await handleGitRequest(
      new Request(`${base}/info/lfs/objects/${await sha256Hex(bytes)}`, { method: 'PUT', body: bytes as Uint8Array<ArrayBuffer>, headers: { 'Content-Length': '5' } }),
      options,
    )
    expect(put!.status).toBe(413)
    expect(await store.head(lfsObjectKey(repo, await sha256Hex(bytes)))).toBeNull()
  })
})
