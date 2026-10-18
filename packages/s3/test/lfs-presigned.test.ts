import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { createRepository, handleGitRequest, lfsObjectKey, sha256Hex, withPresigner } from '@git-forge/core'
import { gitEnv, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeS3TestStorage, s3TestConfig } from './env.ts'

const run = promisify(execFile)

const BODY_LIMIT = 1024 * 1024

const lfsFilterConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
  ['lfs.locksverify', 'false'],
] as const

const env = {
  ...process.env,
  ...gitEnv,
  GIT_CONFIG_COUNT: String(lfsFilterConfig.length),
  ...Object.fromEntries(lfsFilterConfig.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
}

const git = async (cwd: string, args: readonly string[]): Promise<string> => (await run('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 })).stdout

const randomBytes = (size: number, seed: number): Uint8Array => {
  const out = new Uint8Array(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

describe.skipIf(!s3TestConfig)('git lfs through presigned URLs onto the same bucket', () => {
  const base = makeS3TestStorage()
  const storage = withPresigner(base, makeS3TestStorage())
  const repo = { owner: 'presigned', name: `lfs-${Date.now().toString(36)}` }
  const oversized: string[] = []
  let server: RunningServer

  beforeAll(async () => {
    await createRepository(base, repo)
    server = await startServer(async (request) => {
      const length = Number(request.headers.get('content-length') ?? '0')
      if (length > BODY_LIMIT) {
        oversized.push(new URL(request.url).pathname)
        await request.body?.cancel()
        return new Response('request body too large', { status: 413 })
      }
      return (await handleGitRequest(request, { storage, lfs: { maxObjectBytes: 64 * 1024 * 1024 } })) ?? new Response('not found', { status: 404 })
    })
  })

  afterAll(async () => {
    await server?.close()
  })

  it('pushes and clones an LFS object larger than the function body limit with the real git-lfs client', { timeout: 60_000 }, async () => {
    const remote = `${server.url}/${repo.owner}/${repo.name}.git`
    const big = randomBytes(3 * BODY_LIMIT + 17, 7)
    const source = tempDir()
    await git(source, ['init', '-q', '-b', 'main'])
    await git(source, ['remote', 'add', 'origin', remote])
    await git(source, ['lfs', 'track', '*.bin'])
    writeFile(source, 'big.bin', big)
    await git(source, ['add', '-A'])
    await git(source, ['commit', '-q', '-m', 'big object'])
    await git(source, ['push', '-q', 'origin', 'main'])

    const oid = sha256Hex(big)
    expect((await base.head(lfsObjectKey(repo, oid)))?.size).toBe(big.length)
    expect(oversized).toEqual([])
    expect(server.requests.some((request) => request.method === 'PUT')).toBe(false)
    expect(server.requests.some((request) => request.method === 'POST' && request.path.endsWith('/info/lfs/objects/verify') && request.status === 200)).toBe(true)

    const clone = tempDir()
    await git(clone, ['clone', '-q', remote, 'out'])
    expect(new Uint8Array(readFileSync(`${clone}/out/big.bin`))).toEqual(big)
    expect(server.requests.some((request) => request.method === 'GET' && request.path.includes('/info/lfs/objects/'))).toBe(false)
  })
})
