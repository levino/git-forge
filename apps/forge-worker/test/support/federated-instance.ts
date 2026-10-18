import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import {
  type AccountsStore,
  applyMigrations,
  createAccountsStore,
  createJwksCache,
  generateSigningKey,
  MIGRATIONS,
  type SigningKey,
} from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import {
  type ByteRange,
  createMemoryJobQueue,
  type FetchFunction,
  MemoryStorage,
  type MemoryJobQueue,
  type ObjectInfo,
  type PutBody,
  type PutOptions,
  type PutResult,
  type Storage,
  type StoredObject,
} from '@git-forge/core'
import { type ForgeConfig, handleRequest } from '../../src/app.ts'
import { type ForgeJob, type MirrorFederation, runJob } from '../../src/mirror-federation.ts'

export const ADMIN_TOKEN = 'admin-secret'

export type Invocation = {
  readonly kind: 'request' | 'job'
  readonly label: string
  readonly cpuMs: number
  readonly wallMs: number
  readonly storageOps: number
  readonly fetches: number
  readonly ok: boolean
}

export class CountingStorage implements Storage {
  operations = 0
  readonly #inner: Storage

  constructor(inner: Storage) {
    this.#inner = inner
  }

  get(key: string, range?: ByteRange): Promise<StoredObject | null> {
    this.operations++
    return this.#inner.get(key, range)
  }

  head(key: string): Promise<ObjectInfo | null> {
    this.operations++
    return this.#inner.head(key)
  }

  put(key: string, body: PutBody, size: number, options?: PutOptions): Promise<PutResult> {
    this.operations++
    return this.#inner.put(key, body, size, options)
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    this.operations++
    yield* this.#inner.list(prefix)
  }
}

export type Instance = {
  readonly name: string
  readonly url: string
  readonly key: SigningKey
  readonly storage: MemoryStorage
  readonly store: AccountsStore
  readonly jobs: MemoryJobQueue<ForgeJob>
  readonly federation: MirrorFederation
  readonly invocations: Invocation[]
  readonly requests: { readonly method: string; readonly path: string }[]
  failNextFetches: (predicate: (request: Request) => boolean, count: number) => void
  api: (method: string, path: string, body?: unknown) => Promise<Response>
  close: () => Promise<void>
}

export type InstanceOptions = {
  readonly retryDelayMs?: (seconds: number) => number
  readonly safetySyncHours?: number
}

const cpuNow = () => {
  const usage = process.cpuUsage()
  return (usage.user + usage.system) / 1000
}

const measured = async <T>(record: (sample: { cpuMs: number; wallMs: number }) => void, action: () => Promise<T>): Promise<T> => {
  const startCpu = cpuNow()
  const startWall = performance.now()
  try {
    return await action()
  } finally {
    record({ cpuMs: cpuNow() - startCpu, wallMs: performance.now() - startWall })
  }
}

export const startInstance = async (name: string, options: InstanceOptions = {}): Promise<Instance> => {
  const storage = new MemoryStorage()
  const counting = new CountingStorage(storage)
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const store = createAccountsStore(db)
  const { key } = await generateSigningKey()
  const invocations: Invocation[] = []
  const requests: { method: string; path: string }[] = []
  let failures: { predicate: (request: Request) => boolean; remaining: number } | null = null
  let fetches = 0
  const outbound: FetchFunction = async (request) => {
    fetches++
    if (failures && failures.remaining > 0 && failures.predicate(request)) {
      failures.remaining--
      throw new TypeError('fetch failed: simulated network error')
    }
    return globalThis.fetch(request)
  }
  let server: Server | undefined
  let handler: (request: Request) => Promise<Response> = async () => new Response('starting', { status: 503 })
  server = createServer((incoming, outgoing) => {
    const headers = new Headers()
    for (const [header, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(header, value)
    const method = incoming.method ?? 'GET'
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: Readable.toWeb(incoming) as ReadableStream, duplex: 'half' }),
    } as RequestInit)
    requests.push({ method, path: new URL(request.url).pathname })
    void (async () => {
      try {
        const response = await handler(request)
        const body = new Uint8Array(await response.arrayBuffer())
        outgoing.statusCode = response.status
        response.headers.forEach((value, header) => outgoing.setHeader(header, value))
        outgoing.end(body)
      } catch (error) {
        outgoing.statusCode = 500
        outgoing.end(String(error))
      }
    })()
  })
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const invocation = async <T>(kind: Invocation['kind'], label: string, action: () => Promise<T>, ok: (value: T) => boolean): Promise<T> => {
    const opsBefore = counting.operations
    const fetchesBefore = fetches
    let succeeded = false
    return measured(
      (sample) => invocations.push({ kind, label, ...sample, storageOps: counting.operations - opsBefore, fetches: fetches - fetchesBefore, ok: succeeded }),
      async () => {
        const result = await action()
        succeeded = ok(result)
        return result
      },
    )
  }
  const jobs = createMemoryJobQueue<ForgeJob>((job) => invocation('job', job.kind, () => runJob(federation, job), () => true), {
    maxAttempts: 6,
    delayMs: options.retryDelayMs ?? ((seconds) => seconds),
  })
  const federation: MirrorFederation = {
    storage: counting,
    store,
    issuer: url,
    key,
    jwks: createJwksCache({ allowInsecureHttp: true, fetch: (input, init) => outbound(new Request(input, init)) }),
    jobs,
    canRead: async () => true,
    fetch: outbound,
    safetySyncHours: options.safetySyncHours ?? 24,
    deepCheckDays: 0,
  }
  const config: ForgeConfig = { storage: counting, adminToken: ADMIN_TOKEN, publicRead: true, maxPushBytes: 64 * 1024 * 1024, federation }
  handler = (request) =>
    invocation('request', `${request.method} ${new URL(request.url).pathname}`, () => handleRequest(request, config), (response) => response.ok)
  return {
    name,
    url,
    key,
    storage,
    store,
    jobs,
    federation,
    invocations,
    requests,
    failNextFetches: (predicate, count) => {
      failures = { predicate, remaining: count }
    },
    api: (method, path, body) =>
      fetch(`${url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    close: async () => {
      await jobs.idle()
      await new Promise<void>((done) => server!.close(() => done()))
    },
  }
}

export const quiesce = async (instances: readonly Instance[]): Promise<void> => {
  for (let round = 0; round < 4; round++) for (const instance of instances) await instance.jobs.idle()
}
