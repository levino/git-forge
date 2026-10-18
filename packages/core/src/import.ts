import { fromUtf8, readAll, SizeLimitError, utf8 } from './bytes.ts'
import { type ObjectId } from './hash.ts'
import { connectRemote, type Protocol, type RemoteConnection, storeFetchedPack } from './fetch-client.ts'
import { LFS_POINTER_MAX_SIZE, parseLfsPointer } from './lfs.ts'
import { type LfsMissing, type LfsPointer, mirrorLfsObjects } from './lfs-mirror.ts'
import { commitClosure, type RefUpdate, scanNewObjects, selectUpstreamRefs } from './mirror.ts'
import { type GitObject, parseCommit, parseTag } from './objects.ts'
import { parsePack } from './pack.ts'
import { archiveName } from './receive-pack.ts'
import type { AuthorizationSupplier, FetchFunction, Remote } from './remote.ts'
import {
  createRepository,
  isValidName,
  ObjectDatabase,
  readRefs,
  type RefsState,
  type RepositoryName,
  repositoryPrefix,
  RepositoryExistsError,
  writeRefs,
  writeServerInfo,
} from './repository.ts'
import { fetchFeatures, fetchPackV2, fixedHaves } from './smart-client.ts'
import type { Storage } from './storage.ts'
import { checkConnectivity, isAncestor, type ObjectSource } from './walk.ts'

export type ImportPhase = 'discover' | 'graph' | 'fetch' | 'lfs' | 'refs' | 'done' | 'failed'

export type ImportState = {
  readonly version: 1
  readonly url: string
  readonly lfs: boolean
  readonly lfsUrl?: string
  readonly phase: ImportPhase
  readonly createdAt: string
  readonly updatedAt: string
  readonly finishedAt?: string
  readonly steps: number
  readonly failures: number
  readonly error?: string
  readonly failedIn?: ImportPhase
  readonly commitsPerStep: number
  readonly protocol?: Protocol
  readonly head?: string
  readonly targets: Readonly<Record<string, ObjectId>>
  readonly localTips: readonly ObjectId[]
  readonly wants: readonly ObjectId[]
  readonly stepped: boolean
  readonly commits: number
  readonly position: number
  readonly cuts: readonly ObjectId[]
  readonly fetched: { readonly objects: number; readonly packs: number; readonly bytes: number }
  readonly lfsQueue: readonly LfsPointer[]
  readonly lfsMissing: readonly LfsMissing[]
  readonly updates: readonly RefUpdate[]
}

export type ImportSettings = {
  readonly url: string
  readonly lfs?: boolean
  readonly lfsUrl?: string
  readonly commitsPerStep?: number
  readonly defaultBranch?: string
}

export class ImportRunningError extends Error {}

export class ImportNotFoundError extends Error {}

export const DEFAULT_COMMITS_PER_STEP = 500

export const MAX_COMMITS_PER_STEP = 20_000

export const DEFAULT_MAX_STEP_BYTES = 32 * 1024 * 1024

export const DEFAULT_MAX_GRAPH_BYTES = 64 * 1024 * 1024

export const DEFAULT_MAX_FAILURES = 5

const LFS_PER_STEP = 100

const importPrefix = (repo: RepositoryName) => `${repositoryPrefix(repo)}import/`

export const importStateKey = (repo: RepositoryName): string => `${importPrefix(repo)}status.json`

export const importCommitsKey = (repo: RepositoryName): string => `${importPrefix(repo)}commits.txt`

export const isImportFinished = (state: ImportState): boolean => state.phase === 'done' || state.phase === 'failed'

const readState = async (storage: Storage, repo: RepositoryName): Promise<{ value: ImportState; etag: string } | null> => {
  const stored = await storage.get(importStateKey(repo))
  return stored ? { value: JSON.parse(fromUtf8(await readAll(stored.body))) as ImportState, etag: stored.etag } : null
}

const writeState = async (storage: Storage, repo: RepositoryName, state: ImportState, etag: string | null): Promise<boolean> => {
  const bytes = utf8(`${JSON.stringify(state, null, 2)}\n`)
  const result = await storage.put(importStateKey(repo), bytes, bytes.length, {
    contentType: 'application/json',
    ...(etag ? { ifMatch: etag } : { ifNoneMatch: '*' as const }),
  })
  return result.ok
}

export const readImportState = async (storage: Storage, repo: RepositoryName): Promise<ImportState | null> =>
  (await readState(storage, repo))?.value ?? null

const validUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

const freshState = (settings: ImportSettings, at: string): ImportState => ({
  version: 1,
  url: settings.url,
  lfs: settings.lfs ?? true,
  ...(settings.lfsUrl ? { lfsUrl: settings.lfsUrl } : {}),
  phase: 'discover',
  createdAt: at,
  updatedAt: at,
  steps: 0,
  failures: 0,
  commitsPerStep: Math.min(Math.max(1, Math.floor(settings.commitsPerStep ?? DEFAULT_COMMITS_PER_STEP)), MAX_COMMITS_PER_STEP),
  targets: {},
  localTips: [],
  wants: [],
  stepped: false,
  commits: 0,
  position: 0,
  cuts: [],
  fetched: { objects: 0, packs: 0, bytes: 0 },
  lfsQueue: [],
  lfsMissing: [],
  updates: [],
})

export const startImport = async (storage: Storage, repo: RepositoryName, settings: ImportSettings, now = new Date()): Promise<ImportState> => {
  if (!isValidName(repo.owner) || !isValidName(repo.name)) throw new Error('invalid repository name')
  if (!validUrl(settings.url)) throw new Error(`invalid import URL ${settings.url}; pass credentials separately`)
  if (settings.lfsUrl !== undefined && !validUrl(settings.lfsUrl)) throw new Error(`invalid LFS URL ${settings.lfsUrl}`)
  try {
    await createRepository(storage, repo, settings.defaultBranch ?? 'main')
  } catch (error) {
    if (!(error instanceof RepositoryExistsError)) throw error
  }
  const at = now.toISOString()
  for (let attempt = 0; attempt < 10; attempt++) {
    const stored = await readState(storage, repo)
    const previous = stored?.value
    if (previous && !isImportFinished(previous)) throw new ImportRunningError(`an import into ${repo.owner}/${repo.name} is already running`)
    const resume = previous?.phase === 'failed' && previous.url === settings.url && previous.failedIn !== undefined
    const state: ImportState = resume
      ? (({ error: _error, failedIn: _failedIn, ...rest }) => ({ ...rest, phase: previous.failedIn as ImportPhase, failures: 0, updatedAt: at }))(previous)
      : freshState(settings, at)
    if (await writeState(storage, repo, state, stored?.etag ?? null)) return state
  }
  throw new Error('could not start import')
}

export type IngestedPack = {
  readonly name: string | null
  readonly objects: readonly GitObjectWithId[]
}

export type GitObjectWithId = GitObject & { readonly id: ObjectId }

export type PackIngester = (odb: ObjectDatabase, pack: Uint8Array) => Promise<IngestedPack>

export const ingestInMemory: PackIngester = (odb, pack) => storeFetchedPack(odb, pack)

export type ImportStepOptions = {
  readonly storage: Storage
  readonly repo: RepositoryName
  readonly ingestPack?: PackIngester
  readonly fetch?: FetchFunction
  readonly getAuthorization?: AuthorizationSupplier
  readonly now?: () => Date
  readonly maxStepBytes?: number
  readonly maxGraphBytes?: number
  readonly maxFailures?: number
}

type StepContext = {
  readonly options: ImportStepOptions
  readonly odb: ObjectDatabase
  readonly remote: Remote
  readonly now: () => Date
}

const remoteFor = (options: ImportStepOptions, url: string): Remote => ({
  url,
  ...(options.fetch ? { fetch: options.fetch } : {}),
  ...(options.getAuthorization ? { getAuthorization: options.getAuthorization } : {}),
})

const peel = (objects: ReadonlyMap<ObjectId, GitObject>, id: ObjectId): ObjectId | null => {
  let current = id
  for (let depth = 0; depth < 10; depth++) {
    const object = objects.get(current)
    if (!object) return null
    if (object.type === 'commit') return current
    if (object.type !== 'tag') return null
    current = parseTag(object.data).object
  }
  return null
}

export const commitOrder = (commits: ReadonlyMap<ObjectId, readonly ObjectId[]>, tips: readonly ObjectId[]): ObjectId[] => {
  const order: ObjectId[] = []
  const state = new Map<ObjectId, 'open' | 'closed'>()
  for (const tip of tips) {
    if (!commits.has(tip) || state.has(tip)) continue
    const stack: { id: ObjectId; next: number }[] = [{ id: tip, next: 0 }]
    state.set(tip, 'open')
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: ObjectId; next: number }
      const parents = commits.get(frame.id) ?? []
      if (frame.next < parents.length) {
        const parent = parents[frame.next++] as ObjectId
        if (commits.has(parent) && !state.has(parent)) {
          state.set(parent, 'open')
          stack.push({ id: parent, next: 0 })
        }
        continue
      }
      stack.pop()
      state.set(frame.id, 'closed')
      order.push(frame.id)
    }
  }
  return order
}

export const planImportRefUpdates = async (
  current: Readonly<Record<string, ObjectId>>,
  targets: Readonly<Record<string, ObjectId>>,
  at: Date,
  isFastForward: (oldId: ObjectId, newId: ObjectId) => Promise<boolean>,
): Promise<{ refs: Record<string, ObjectId>; updates: RefUpdate[] }> => {
  const refs: Record<string, ObjectId> = { ...current }
  const updates: RefUpdate[] = []
  for (const [name, id] of Object.entries(targets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const oldId = current[name]
    if (oldId === id) continue
    refs[name] = id
    if (oldId === undefined) {
      updates.push({ ref: name, oldId: null, newId: id, kind: 'created' })
      continue
    }
    const fastForward = name.startsWith('refs/heads/') && (await isFastForward(oldId, id))
    if (!fastForward) refs[archiveName(name, at)] = oldId
    updates.push({ ref: name, oldId, newId: id, kind: fastForward ? 'fast-forward' : 'forced' })
  }
  return { refs, updates }
}

const lfsPointers = (objects: Iterable<GitObject>): LfsPointer[] => {
  const found: LfsPointer[] = []
  for (const object of objects) {
    if (object.type !== 'blob' || object.data.length > LFS_POINTER_MAX_SIZE) continue
    const pointer = parseLfsPointer(object.data)
    if (pointer) found.push({ oid: pointer.oid, size: pointer.size })
  }
  return found
}

const mergeLfs = (queue: readonly LfsPointer[], found: readonly LfsPointer[]): LfsPointer[] => {
  const byOid = new Map(queue.map((pointer) => [pointer.oid, pointer]))
  for (const pointer of found) if (!byOid.has(pointer.oid)) byOid.set(pointer.oid, pointer)
  return [...byOid.values()]
}

const afterFetch = (state: ImportState): ImportPhase => (state.lfs && state.lfsQueue.length > 0 ? 'lfs' : 'refs')

const discover = async (context: StepContext, state: ImportState): Promise<ImportState> => {
  const { options, odb, remote } = context
  const connection = await connectRemote(remote, 'auto')
  const listing = await connection.listRefs(['refs/heads/', 'refs/tags/'])
  const upstream = selectUpstreamRefs(listing.refs, '', listing.head)
  const local = await readRefs(options.storage, options.repo)
  if (!local) throw new ImportNotFoundError(`repository ${options.repo.owner}/${options.repo.name} not found`)
  const localTips = [...new Set(Object.values(local.state.refs))]
  const connected = await commitClosure(odb, localTips)
  const wants = [...new Set(upstream.refs.values())].filter((id) => !connected.has(id))
  const filter = connection.protocol === 'v2' && connection.capabilities !== undefined && fetchFeatures(connection.capabilities).has('filter')
  const next: ImportState = {
    ...state,
    protocol: connection.protocol,
    ...(upstream.head ? { head: upstream.head } : {}),
    targets: Object.fromEntries(upstream.refs),
    localTips,
    wants,
    stepped: filter,
  }
  if (wants.length === 0) return { ...next, phase: 'refs' }
  return { ...next, phase: filter ? 'graph' : 'fetch' }
}

const v2Capabilities = (connection: RemoteConnection) => {
  if (connection.protocol !== 'v2' || !connection.capabilities) throw new Error('the remote no longer speaks protocol v2')
  return connection.capabilities
}

const graph = async (context: StepContext, state: ImportState): Promise<ImportState> => {
  const { options, odb, remote } = context
  const connection = await connectRemote(remote, 'v2')
  const fetched = await fetchPackV2(remote, v2Capabilities(connection), {
    wants: state.wants,
    haves: fixedHaves(state.localTips),
    filter: 'tree:0',
    maxPackBytes: options.maxGraphBytes ?? DEFAULT_MAX_GRAPH_BYTES,
  })
  const parsed = await parsePack(fetched.pack, (id) => odb.read(id))
  const objects = new Map<ObjectId, GitObject>(parsed.objects.map((object) => [object.id, object]))
  const commits = new Map<ObjectId, readonly ObjectId[]>()
  for (const object of parsed.objects) if (object.type === 'commit') commits.set(object.id, parseCommit(object.data).parents)
  const tips = state.wants.map((id) => peel(objects, id)).filter((id): id is ObjectId => id !== null)
  const order = commitOrder(commits, tips)
  const text = utf8(order.length > 0 ? `${order.join('\n')}\n` : '')
  await options.storage.put(importCommitsKey(options.repo), text, text.length, { contentType: 'text/plain' })
  return { ...state, phase: 'fetch', commits: order.length, position: 0, cuts: [] }
}

const readCommitOrder = async (storage: Storage, repo: RepositoryName): Promise<ObjectId[]> => {
  const stored = await storage.get(importCommitsKey(repo))
  if (!stored) throw new Error('import commit list is missing')
  return fromUtf8(await readAll(stored.body)).split('\n').filter(Boolean)
}

const verifyFetched = async (odb: ObjectDatabase, fresh: ReadonlyMap<ObjectId, GitObject>, wants: readonly ObjectId[]): Promise<void> => {
  const source: ObjectSource = { read: async (id) => fresh.get(id) ?? (await odb.read(id)) }
  for (const want of wants) {
    const missing = await checkConnectivity(source, want, (id) => fresh.has(id), (id) => odb.has(id))
    if (missing) throw new Error(`the remote did not send object ${missing}`)
  }
}

const fetchStepped = async (context: StepContext, state: ImportState): Promise<ImportState> => {
  const { options, odb, remote } = context
  const maxStepBytes = options.maxStepBytes ?? DEFAULT_MAX_STEP_BYTES
  const order = await readCommitOrder(options.storage, options.repo)
  const final = state.position >= order.length
  const end = Math.min(state.position + state.commitsPerStep, order.length)
  const wants = final ? state.wants : [order[end - 1] as ObjectId]
  const missing: ObjectId[] = []
  for (const want of wants) if (!(await odb.has(want))) missing.push(want)
  let fetched = state.fetched
  let lfsQueue = state.lfsQueue
  let commitsPerStep = state.commitsPerStep
  if (missing.length > 0) {
    const connection = await connectRemote(remote, 'v2')
    let pack: Uint8Array
    try {
      pack = (
        await fetchPackV2(remote, v2Capabilities(connection), {
          wants: missing,
          haves: fixedHaves([...state.localTips, ...state.cuts]),
          maxPackBytes: maxStepBytes,
        })
      ).pack
    } catch (error) {
      if (error instanceof SizeLimitError && !final && state.commitsPerStep > 1) {
        return { ...state, commitsPerStep: Math.max(1, Math.floor(state.commitsPerStep / 4)) }
      }
      throw error
    }
    const stored = await (options.ingestPack ?? ingestInMemory)(odb, pack)
    const fresh = new Map<ObjectId, GitObject>(stored.objects.map((object) => [object.id, object]))
    await verifyFetched(odb, fresh, missing)
    fetched = { objects: fetched.objects + stored.objects.length, packs: fetched.packs + (stored.name ? 1 : 0), bytes: fetched.bytes + pack.length }
    if (state.lfs) lfsQueue = mergeLfs(lfsQueue, lfsPointers(stored.objects))
    if (pack.length < maxStepBytes / 8) commitsPerStep = Math.min(commitsPerStep * 2, MAX_COMMITS_PER_STEP)
  }
  const next: ImportState = { ...state, fetched, lfsQueue, commitsPerStep }
  if (final) return { ...next, phase: afterFetch(next) }
  return { ...next, position: end, cuts: [...state.cuts, order[end - 1] as ObjectId] }
}

const fetchWhole = async (context: StepContext, state: ImportState): Promise<ImportState> => {
  const { odb, remote, options } = context
  const connection = await connectRemote(remote, state.protocol ?? 'auto')
  const connected = await commitClosure(odb, state.localTips)
  const result = await connection.fetchObjects(odb, {
    wants: state.wants,
    haveTips: state.localTips,
    isConnected: (id) => connected.has(id),
    maxPackBytes: options.maxStepBytes ?? DEFAULT_MAX_STEP_BYTES,
  })
  const scan = await scanNewObjects(odb, state.wants, connected, state.lfs)
  const next: ImportState = {
    ...state,
    fetched: { objects: state.fetched.objects + result.objects, packs: state.fetched.packs + result.packs.length, bytes: state.fetched.bytes },
    lfsQueue: mergeLfs(state.lfsQueue, scan.lfs.map(({ oid, size }) => ({ oid, size }))),
  }
  return { ...next, phase: afterFetch(next) }
}

const lfs = async (context: StepContext, state: ImportState): Promise<ImportState> => {
  const batch = state.lfsQueue.slice(0, LFS_PER_STEP)
  const result = await mirrorLfsObjects({
    storage: context.options.storage,
    repo: context.options.repo,
    remote: context.remote,
    ...(state.lfsUrl ? { endpoint: state.lfsUrl } : {}),
    objects: batch,
  })
  const next: ImportState = { ...state, lfsQueue: state.lfsQueue.slice(batch.length), lfsMissing: [...state.lfsMissing, ...result.missing] }
  return next.lfsQueue.length > 0 ? next : { ...next, phase: 'refs' }
}

const updateRefs = async (context: StepContext, state: ImportState): Promise<ImportState> => {
  const { options, odb } = context
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await readRefs(options.storage, options.repo)
    if (!current) throw new ImportNotFoundError(`repository ${options.repo.owner}/${options.repo.name} not found`)
    const plan = await planImportRefUpdates(current.state.refs, state.targets, context.now(), (oldId, newId) => isAncestor(odb, oldId, newId))
    const adoptHead = Object.keys(current.state.refs).length === 0 && state.head !== undefined && state.targets[state.head] !== undefined
    const head = adoptHead ? (state.head as string) : current.state.head
    const done = { ...state, phase: 'done' as const, updates: plan.updates, finishedAt: context.now().toISOString() }
    const next: RefsState = { head, refs: plan.refs }
    if (plan.updates.length === 0 && head === current.state.head) {
      await writeServerInfo(options.storage, options.repo, current.state, odb)
      return done
    }
    if (await writeRefs(options.storage, options.repo, next, current.etag)) {
      await writeServerInfo(options.storage, options.repo, next, odb)
      return done
    }
  }
  throw new Error('could not update refs')
}

const runPhase = (context: StepContext, state: ImportState): Promise<ImportState> => {
  switch (state.phase) {
    case 'discover':
      return discover(context, state)
    case 'graph':
      return graph(context, state)
    case 'fetch':
      return state.stepped ? fetchStepped(context, state) : fetchWhole(context, state)
    case 'lfs':
      return lfs(context, state)
    case 'refs':
      return updateRefs(context, state)
    default:
      return Promise.resolve(state)
  }
}

export const importStep = async (options: ImportStepOptions): Promise<ImportState> => {
  const now = options.now ?? (() => new Date())
  const stored = await readState(options.storage, options.repo)
  if (!stored) throw new ImportNotFoundError(`no import for ${options.repo.owner}/${options.repo.name}`)
  const state = stored.value
  if (isImportFinished(state)) return state
  const context: StepContext = { options, odb: new ObjectDatabase(options.storage, options.repo), remote: remoteFor(options, state.url), now }
  let next: ImportState
  try {
    const { error: _error, ...progressed } = await runPhase(context, state)
    next = { ...progressed, failures: 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failures = state.failures + 1
    const exhausted = failures >= (options.maxFailures ?? DEFAULT_MAX_FAILURES) || error instanceof ImportNotFoundError
    next = { ...state, failures, error: message, ...(exhausted ? { phase: 'failed' as const, failedIn: state.phase, finishedAt: now().toISOString() } : {}) }
  }
  next = { ...next, steps: state.steps + 1, updatedAt: now().toISOString() }
  if (await writeState(options.storage, options.repo, next, stored.etag)) return next
  return (await readImportState(options.storage, options.repo)) ?? next
}

export const runImport = async (options: ImportStepOptions & { readonly maxSteps?: number }): Promise<ImportState> => {
  const limit = options.maxSteps ?? 100_000
  let state = await importStep(options)
  for (let step = 1; step < limit && !isImportFinished(state); step++) state = await importStep(options)
  return state
}

export type ImportJob = {
  readonly owner: string
  readonly name: string
  readonly authorization?: string
}

export type ImportScheduler = (job: ImportJob, delaySeconds: number) => Promise<void>

export const retryDelaySeconds = (failures: number): number => (failures === 0 ? 0 : Math.min(15 * 2 ** (failures - 1), 600))

export const continueImport = async (
  job: ImportJob,
  options: Omit<ImportStepOptions, 'repo' | 'getAuthorization'> & { readonly schedule: ImportScheduler },
): Promise<ImportState> => {
  const authorization = job.authorization
  const state = await importStep({
    ...options,
    repo: { owner: job.owner, name: job.name },
    ...(authorization ? { getAuthorization: async () => authorization } : {}),
  })
  if (!isImportFinished(state)) await options.schedule(job, retryDelaySeconds(state.failures))
  return state
}
