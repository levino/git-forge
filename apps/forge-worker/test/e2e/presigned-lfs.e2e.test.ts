import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitEnv, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const run = promisify(execFile)

const BOOTSTRAP_TOKEN = `e2e-bootstrap-${crypto.randomUUID()}`
const BUCKET = 'levins-git-forge'

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

type BucketRequest = { method: string; path: string; signedHeaders: string | null; checksum: string | null; length: string | null }

const object = new Uint8Array(Array.from({ length: 2_500_000 }, (_, i) => (i * 131 + (i >> 11)) % 256))
const oid = createHash('sha256').update(object).digest('hex')

let dev: WranglerDev
let bucket: Server
let admin = ''
const seen: BucketRequest[] = []

const startBucket = (forward: () => { url: string; token: string }): Promise<Server> =>
  new Promise((ready) => {
    const server = createServer((incoming, outgoing) => {
      const url = new URL(incoming.url ?? '/', 'http://bucket')
      const match = /^\/levins-git-forge\/repos\/([^/]+)\/([^/]+)\/lfs\/objects\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})$/.exec(url.pathname)
      seen.push({
        method: incoming.method ?? '',
        path: url.pathname,
        signedHeaders: url.searchParams.get('X-Amz-SignedHeaders'),
        checksum: (incoming.headers['x-amz-checksum-sha256'] as string | undefined) ?? null,
        length: incoming.headers['content-length'] ?? null,
      })
      if (!match || !url.searchParams.get('X-Amz-Signature')) {
        outgoing.writeHead(403).end()
        return
      }
      const [, owner, name, key] = match as unknown as [string, string, string, string]
      const target = `${forward().url}/${owner}/${name}.git/info/lfs/objects/${key}`
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        const body = Buffer.concat(chunks)
        if (incoming.method === 'PUT' && createHash('sha256').update(body).digest('base64') !== incoming.headers['x-amz-checksum-sha256']) {
          outgoing.writeHead(400).end('BadDigest')
          return
        }
        fetch(target, {
          method: incoming.method ?? 'GET',
          headers: { Authorization: `Bearer ${forward().token}`, ...(incoming.method === 'PUT' ? { 'Content-Length': String(body.length) } : {}) },
          ...(incoming.method === 'PUT' ? { body } : {}),
        })
          .then(async (response) => outgoing.writeHead(response.status, { 'Content-Type': 'application/octet-stream' }).end(Buffer.from(await response.arrayBuffer())))
          .catch(() => outgoing.writeHead(502).end())
      })
    })
    server.listen(0, '127.0.0.1', () => ready(server))
  })

beforeAll(async () => {
  bucket = await startBucket(() => ({ url: dev.url, token: admin }))
  dev = await startWranglerDev({
    vars: {
      BOOTSTRAP_TOKEN,
      R2_S3_ENDPOINT: `http://127.0.0.1:${(bucket.address() as AddressInfo).port}`,
      R2_BUCKET_NAME: BUCKET,
      R2_ACCESS_KEY_ID: 'e2e-key',
      R2_SECRET_ACCESS_KEY: 'e2e-secret',
    },
  })
  const post = async (path: string, token: string, body: unknown) =>
    fetch(`${dev.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const bootstrapped = await post('/api/bootstrap', BOOTSTRAP_TOKEN, { login: 'e2e' })
  expect(bootstrapped.status).toBe(201)
  admin = ((await bootstrapped.json()) as { token: string }).token
  expect((await post('/api/repos', admin, { owner: 'e2e', name: 'assets' })).status).toBe(201)
}, 120_000)

afterAll(async () => {
  await dev?.stop()
  await new Promise((done) => bucket?.close(done))
})

describe('presigned R2 LFS URLs on wrangler dev', () => {
  it('sends git-lfs to the signed bucket URLs and verifies the object through the binding', { timeout: 120_000 }, async () => {
    const remote = `${dev.url.replace('http://', `http://git:${admin}@`)}/e2e/assets.git`
    const dir = tempDir()
    await git(dir, ['init', '-q', '-b', 'main'])
    await git(dir, ['remote', 'add', 'origin', remote])
    await git(dir, ['lfs', 'track', '*.bin'])
    writeFileSync(join(dir, 'model.bin'), object)
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'add model'])
    await git(dir, ['push', '-q', 'origin', 'main'])

    const upload = seen.find((request) => request.method === 'PUT')
    expect(upload).toEqual({
      method: 'PUT',
      path: `/${BUCKET}/repos/e2e/assets/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`,
      signedHeaders: 'content-length;host;x-amz-checksum-sha256',
      checksum: createHash('sha256').update(object).digest('base64'),
      length: String(object.length),
    })

    const clone = tempDir()
    await git(clone, ['clone', '-q', remote, 'out'])
    expect(new Uint8Array(readFileSync(join(clone, 'out', 'model.bin')))).toEqual(object)
    expect(seen.some((request) => request.method === 'GET' && request.path.endsWith(oid))).toBe(true)
  })
})
