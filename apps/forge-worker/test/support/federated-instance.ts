import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import {
  type AccountsStore,
  applyMigrations,
  createAccountsStore,
  generateSigningKey,
  importSigningKey,
  MIGRATIONS,
  type PrivateJwk,
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
import { createForge, type Forge, type ForgeOptions } from '../../src/app.ts'
import { DEFAULT_MAX_LFS_OBJECT_BYTES } from '../../src/config.ts'
import type { ForgeJob } from '../../src/mirror-federation.ts'

export const BOOTSTRAP_TOKEN = 'bootstrap-secret'

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
  readonly storage: Storage
  readonly store: AccountsStore
  readonly jobs: MemoryJobQueue<ForgeJob>
  readonly forge: Forge
  readonly options: ForgeOptions
  readonly invocations: Invocation[]
  readonly requests: { readonly method: string; readonly path: string }[]
  readonly token: string
  failNextFetches: (predicate: (request: Request) => boolean, count: number) => void
  api: (method: string, path: string, body?: unknown) => Promise<Response>
  gitUrl: (repository: string, withToken?: boolean) => string
  close: () => Promise<void>
}

export type InstanceOptions = {
  readonly retryDelayMs?: (seconds: number) => number
  readonly storage?: Storage
  readonly privateJwk?: PrivateJwk
  readonly login?: string
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
  const storage = options.storage ?? new MemoryStorage()
  const counting = new CountingStorage(storage)
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const store = createAccountsStore(db)
  const key = options.privateJwk ? await importSigningKey(options.privateJwk) : (await generateSigningKey()).key
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
  let handler: (request: Request) => Promise<Response> = async () => new Response('starting', { status: 503 })
  const server: Server = createServer((incoming, outgoing) => {
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
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
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
  let forge: Forge | undefined
  const jobs = createMemoryJobQueue<ForgeJob>((job) => invocation('job', job.kind, () => forge!.runJob(job), () => true), {
    maxAttempts: 6,
    delayMs: options.retryDelayMs ?? ((seconds) => seconds),
  })
  const forgeOptions: ForgeOptions = {
    storage: counting,
    db,
    publicUrl: url,
    instanceKey: key,
    bootstrapToken: BOOTSTRAP_TOKEN,
    maxPushBytes: 64 * 1024 * 1024,
    maxLfsObjectBytes: DEFAULT_MAX_LFS_OBJECT_BYTES,
    mirrorIntervalMinutes: 24 * 60,
    allowInsecureFederation: true,
    deepCheckDays: 0,
    fetch: outbound,
    jobs,
  }
  const created = createForge(forgeOptions)
  forge = created
  handler = (request) => invocation('request', `${request.method} ${new URL(request.url).pathname}`, () => created.fetch(request), (response) => response.ok)
  const bootstrap = await fetch(`${url}/api/bootstrap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: options.login ?? 'village' }),
  })
  if (bootstrap.status !== 201) throw new Error(`bootstrap of ${name} failed: ${bootstrap.status} ${await bootstrap.text()}`)
  const token = ((await bootstrap.json()) as { token: string }).token
  return {
    name,
    url,
    key,
    storage,
    store,
    jobs,
    forge: created,
    options: forgeOptions,
    invocations,
    requests,
    token,
    failNextFetches: (predicate, count) => {
      failures = { predicate, remaining: count }
    },
    api: (method, path, body) =>
      fetch(`${url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    gitUrl: (repository, withToken = false) => `${withToken ? url.replace('http://', `http://git:${token}@`) : url}/${repository}.git`,
    close: async () => {
      await jobs.idle()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

export const quiesce = async (instances: readonly Instance[]): Promise<void> => {
  for (let round = 0; round < 4; round++) for (const instance of instances) await instance.jobs.idle()
}
