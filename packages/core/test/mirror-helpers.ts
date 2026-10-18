import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { readAll } from '../src/bytes.ts'
import { sha256Hex } from '../src/hash.ts'
import { handleGitRequest } from '../src/http.ts'
import { lfsObjectKey } from '../src/lfs.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { createRepository, type RepositoryName } from '../src/repository.ts'
import type { ByteRange, ObjectInfo, PutBody, PutOptions, PutResult, Storage, StoredObject } from '../src/storage.ts'
import { gitEnv } from './git-helpers.ts'
import { type FetchHandler, type RunningServer, startServer } from './http-server.ts'

export type MaybeHandler = (request: Request) => Promise<Response | null>

export const chain =
  (...handlers: MaybeHandler[]): FetchHandler =>
  async (request) => {
    for (const handler of handlers) {
      const response = await handler(request)
      if (response) return response
    }
    return new Response('not found\n', { status: 404 })
  }

export type Forge = {
  readonly storage: Storage
  readonly server: RunningServer
  readonly url: (repo: RepositoryName) => string
  readonly createRepo: (repo: RepositoryName) => Promise<string>
}

export const startForge = async (storage: Storage = new MemoryStorage(), extra: MaybeHandler[] = []): Promise<Forge> => {
  const server = await startServer(chain(...extra, (request) => handleGitRequest(request, { storage })))
  const url = (repo: RepositoryName) => `${server.url}/${repo.owner}/${repo.name}.git`
  return {
    storage,
    server,
    url,
    createRepo: async (repo) => {
      await createRepository(storage, repo)
      return url(repo)
    },
  }
}

export const staticBucketHandler =
  (storage: Storage): MaybeHandler =>
  async (request) => {
    if (request.method !== 'GET') return new Response('method not allowed\n', { status: 405 })
    const match = /^\/([^/]+)\/([^/]+?)\.git\/(.+)$/.exec(new URL(request.url).pathname)
    if (!match) return null
    const [, owner, name, path] = match as unknown as [string, string, string, string]
    const object = await storage.get(`repos/${owner}/${name}/git/${path}`)
    if (!object) return new Response('not found\n', { status: 404 })
    return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream' } })
  }

export const staticDirHandler =
  (root: string): MaybeHandler =>
  async (request) => {
    if (request.method !== 'GET') return new Response('method not allowed\n', { status: 405 })
    const path = normalize(decodeURIComponent(new URL(request.url).pathname))
    if (path.includes('..')) return new Response('forbidden\n', { status: 403 })
    try {
      return new Response(await readFile(join(root, path)), { headers: { 'Content-Type': 'text/plain' } })
    } catch {
      return new Response('not found\n', { status: 404 })
    }
  }

export const httpBackendHandler =
  (projectRoot: string): MaybeHandler =>
  async (request) => {
    const url = new URL(request.url)
    if (!/\/(info\/refs|git-upload-pack|git-receive-pack|HEAD|objects\/.*)$/.test(url.pathname)) return null
    const body = request.body ? await readAll(request.body) : new Uint8Array(0)
    const env: Record<string, string> = {
      ...process.env,
      ...gitEnv,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get('Content-Type') ?? '',
      CONTENT_LENGTH: String(body.length),
      REMOTE_ADDR: '127.0.0.1',
    }
    const protocol = request.headers.get('Git-Protocol')
    if (protocol) env.GIT_PROTOCOL = protocol
    const output = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn('git', ['http-backend'], { env })
      const chunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.on('error', reject)
      child.on('close', () => resolve(Buffer.concat(chunks)))
      child.stdin.end(body)
    })
    const split = output.indexOf('\r\n\r\n')
    const headerText = output.subarray(0, split).toString('utf8')
    const headers = new Headers()
    let status = 200
    for (const line of headerText.split('\r\n')) {
      const colon = line.indexOf(':')
      const name = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10)
      else headers.append(name, value)
    }
    return new Response(new Uint8Array(output.subarray(split + 4)), { status, headers })
  }

export const requireAuthorization =
  (expected: string): MaybeHandler =>
  async (request) =>
    request.headers.get('Authorization') === expected
      ? null
      : new Response('authentication required\n', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="test"' } })

export type FakeLfs = {
  readonly handler: MaybeHandler
  readonly batches: { readonly authorization: string | null; readonly oids: readonly string[] }[]
  readonly downloads: string[]
}

export type FakeLfsOptions = {
  readonly read: (oid: string) => Promise<Uint8Array | null>
  readonly authorization?: string
  readonly downloadHeader?: Readonly<Record<string, string>>
  readonly corrupt?: ReadonlySet<string>
}

export const fakeLfs = (options: FakeLfsOptions): FakeLfs => {
  const batches: FakeLfs['batches'][number][] = []
  const downloads: string[] = []
  const handler: MaybeHandler = async (request) => {
    const url = new URL(request.url)
    const download = /\/lfs-download\/([0-9a-f]{64})$/.exec(url.pathname)
    if (download && request.method === 'GET') {
      const oid = download[1] as string
      for (const [name, value] of Object.entries(options.downloadHeader ?? {})) {
        if (request.headers.get(name) !== value) return new Response('bad download header\n', { status: 403 })
      }
      const data = await options.read(oid)
      if (!data) return new Response('not found\n', { status: 404 })
      downloads.push(oid)
      const body = options.corrupt?.has(oid) ? data.map((byte) => byte ^ 0xff) : data
      return new Response(body as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'application/octet-stream' } })
    }
    if (!url.pathname.endsWith('/info/lfs/objects/batch') || request.method !== 'POST') return null
    if (options.authorization && request.headers.get('Authorization') !== options.authorization) {
      return new Response(JSON.stringify({ message: 'credentials needed' }), { status: 401 })
    }
    const body = (await request.json()) as { operation: string; objects: { oid: string; size: number }[] }
    batches.push({ authorization: request.headers.get('Authorization'), oids: body.objects.map((object) => object.oid) })
    const objects = await Promise.all(
      body.objects.map(async ({ oid, size }) => {
        const data = await options.read(oid)
        if (!data) return { oid, size, error: { code: 404, message: 'Object does not exist' } }
        return {
          oid,
          size,
          authenticated: true,
          actions: {
            download: {
              href: `${url.origin}/lfs-download/${oid}`,
              ...(options.downloadHeader ? { header: options.downloadHeader } : {}),
              expires_in: 3600,
            },
          },
        }
      }),
    )
    return new Response(JSON.stringify({ transfer: 'basic', objects, hash_algo: 'sha256' }), {
      headers: { 'Content-Type': 'application/vnd.git-lfs+json' },
    })
  }
  return { handler, batches, downloads }
}

export const storageLfsReader = (storage: Storage, repo: RepositoryName) => async (oid: string) => {
  const object = await storage.get(lfsObjectKey(repo, oid))
  return object ? readAll(object.body) : null
}

export const lfsPointer = (content: Uint8Array): { text: string; oid: string; size: number } => {
  const oid = sha256Hex(content)
  return { text: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`, oid, size: content.length }
}

export const putLfsObject = async (storage: Storage, repo: RepositoryName, content: Uint8Array): Promise<void> => {
  await storage.put(lfsObjectKey(repo, sha256Hex(content)), content, content.length)
}

export const randomBytes = (size: number, seed: number): Uint8Array => {
  const out = new Uint8Array(size)
  let state = seed >>> 0 || 1
  for (let i = 0; i < size; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    out[i] = state & 0xff
  }
  return out
}

export class FaultyStorage implements Storage {
  readonly #inner: Storage
  readonly #shouldFail: (key: string) => boolean

  constructor(inner: Storage, shouldFail: (key: string) => boolean) {
    this.#inner = inner
    this.#shouldFail = shouldFail
  }

  get(key: string, range?: ByteRange): Promise<StoredObject | null> {
    return this.#inner.get(key, range)
  }

  head(key: string): Promise<ObjectInfo | null> {
    return this.#inner.head(key)
  }

  async put(key: string, body: PutBody, size: number, options?: PutOptions): Promise<PutResult> {
    if (this.#shouldFail(key)) throw new Error(`simulated crash while writing ${key}`)
    return this.#inner.put(key, body, size, options)
  }

  list(prefix: string): AsyncIterable<ObjectInfo> {
    return this.#inner.list(prefix)
  }
}

export const basicAuth = (user: string, password: string): string => `Basic ${btoa(`${user}:${password}`)}`
