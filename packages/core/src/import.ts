import { fromUtf8, readAll, utf8 } from './bytes.ts'
import { type ObjectId } from './hash.ts'
import { connectRemote, type Protocol } from './fetch-client.ts'
import { lfsObjectKey } from './lfs.ts'
import type { DigestFactory } from './digest.ts'
import { findLfsConfig, type LfsEndpoint, lfsRefOrder, mayAuthorizeLfs, normalizeLfsUrl } from './lfs-config.ts'
import { lfsEndpointFor, type LfsMirrorResult, type LfsMissing, type LfsPointer, mirrorLfsObjects } from './lfs-mirror.ts'
import { commitClosure, type RefUpdate, scanNewObjects, selectUpstreamRefs } from './mirror.ts'
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
import { fetchFeatures } from './smart-client.ts'
import {
  DEFAULT_COMMITS_PER_STEP,
  DEFAULT_MAX_STEP_BYTES,
  fetchCommitGraph,
  fetchNextStep,
  type FetchSplit,
  MAX_COMMITS_PER_STEP,
  mergeLfs,
  type SteppedFetch,
  type SteppedFetchLimits,
} from './stepped-fetch.ts'
import type { Storage } from './storage.ts'
import { isAncestor } from './walk.ts'

export {
  commitOrder,
  DEFAULT_COMMITS_PER_STEP,
  DEFAULT_MAX_GRAPH_BYTES,
  DEFAULT_MAX_STEP_BYTES,
  type IngestedPack,
  type IngestPackOptions,
  ingestStreamed,
  MAX_BLOBS_PER_STEP,
  MAX_COMMITS_PER_STEP,
  type PackIngester,
} from './stepped-fetch.ts'

export type ImportPhase = 'discover' | 'graph' | 'fetch' | 'lfs' | 'refs' | 'metadata' | 'done' | 'failed'

export type ImportMetadata = { readonly progress: unknown; readonly waitUntil?: string }

export type ImportMetadataResult = ImportMetadata & { readonly done: boolean }

export type ImportSplit = FetchSplit

export type ImportLfsEndpoint = LfsEndpoint

export type ImportState = {
  readonly version: 1
  readonly url: string
  readonly lfs: boolean
  readonly lfsUrl?: string
  readonly lfsEndpoint?: ImportLfsEndpoint
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
  readonly split?: ImportSplit
  readonly fetched: { readonly objects: number; readonly packs: number; readonly bytes: number }
  readonly lfsQueue: readonly LfsPointer[]
  readonly lfsMissing: readonly LfsMissing[]
  readonly lfsPending?: readonly LfsPointer[]
  readonly lfsRound?: number
  readonly lfsProgressAt?: string
  readonly updates: readonly RefUpdate[]
  readonly metadata?: ImportMetadata
}

export type ImportSettings = {
  readonly url: string
  readonly lfs?: boolean
  readonly lfsUrl?: string
  readonly commitsPerStep?: number
  readonly defaultBranch?: string
  readonly metadata?: boolean
}

export class ImportRunningError extends Error {}

export class ImportNotFoundError extends Error {}

export const DEFAULT_MAX_FAILURES = 5

export const STALE_IMPORT_MS = 30 * 60 * 1000

const LFS_PER_STEP = 100

export const DEFAULT_MAX_LFS_STEP_BYTES = 512 * 1024 * 1024

export const LFS_JOB_TIMEOUT_MS = 10 * 60 * 1000

export const LFS_JOB_ROUNDS = 3

export const LFS_POLL_SECONDS = 5

const importPrefix = (repo: RepositoryName) => `${repositoryPrefix(repo)}import/`

export const importStateKey = (repo: RepositoryName): string => `${importPrefix(repo)}status.json`

export const importCommitsKey = (repo: RepositoryName): string => `${importPrefix(repo)}commits.txt`

export const importBlobsKey = (repo: RepositoryName): string => `${importPrefix(repo)}blobs.txt`

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

export const isValidImportUrl = (url: string): boolean => {
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
  ...(settings.metadata ? { metadata: { progress: null } } : {}),
})

export const startImport = async (storage: Storage, repo: RepositoryName, settings: ImportSettings, now = new Date()): Promise<ImportState> => {
  if (!isValidName(repo.owner) || !isValidName(repo.name)) throw new Error('invalid repository name')
  if (!isValidImportUrl(settings.url)) throw new Error(`invalid import URL ${settings.url}; pass credentials separately`)
  if (settings.lfsUrl !== undefined && !isValidImportUrl(settings.lfsUrl)) throw new Error(`invalid LFS URL ${settings.lfsUrl}`)
  try {
    await createRepository(storage, repo, settings.defaultBranch ?? 'main')
  } catch (error) {
    if (!(error instanceof RepositoryExistsError)) throw error
  }
  const at = now.toISOString()
  for (let attempt = 0; attempt < 10; attempt++) {
    const stored = await readState(storage, repo)
    const previous = stored?.value
    const stale = previous !== undefined && !isImportFinished(previous) && now.getTime() - Date.parse(previous.updatedAt) > STALE_IMPORT_MS
    if (previous && !isImportFinished(previous) && !stale) throw new ImportRunningError(`an import into ${repo.owner}/${repo.name} is already running`)
    const resume = previous?.phase === 'failed' && previous.url === settings.url && previous.failedIn !== undefined
    const takeOver = stale && previous.url === settings.url
    const state: ImportState = resume
      ? (({ error: _error, failedIn: _failedIn, ...rest }) => ({ ...rest, phase: previous.failedIn as ImportPhase, failures: 0, updatedAt: at }))(previous)
      : takeOver
        ? { ...previous, failures: 0, updatedAt: at }
        : freshState(settings, at)
    if (await writeState(storage, repo, state, stored?.etag ?? null)) return state
  }
  throw new Error('could not start import')
}

export type ImportStepOptions = SteppedFetchLimits & {
  readonly storage: Storage
  readonly repo: RepositoryName
  readonly fetch?: FetchFunction
  readonly getAuthorization?: AuthorizationSupplier
  readonly now?: () => Date
  readonly maxLfsStepBytes?: number
  readonly digests?: DigestFactory
  readonly maxFailures?: number
  readonly enqueueLfs?: (pointer: LfsPointer, endpoint: ImportLfsEndpoint) => Promise<void>
  readonly importMetadata?: (state: ImportState) => Promise<ImportMetadataResult>
}

type StepContext = {
  readonly options: ImportStepOptions
  readonly odb: ObjectDatabase
  readonly remote: Remote
  readonly now: () => Date
}

const remoteFor = (options: Pick<ImportStepOptions, 'fetch' | 'getAuthorization'>, url: string): Remote => ({
  url,
  ...(options.fetch ? { fetch: options.fetch } : {}),
  ...(options.getAuthorization ? { getAuthorization: options.getAuthorization } : {}),
})

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

const afterFetch = (state: ImportState): ImportPhase => (state.lfs && state.lfsQueue.length + (state.lfsPending?.length ?? 0) > 0 ? 'lfs' : 'refs')

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

const stepped = ({ options, odb, remote }: StepContext): SteppedFetch => ({
  ...options,
  odb,
  remote,
  commitsKey: importCommitsKey(options.repo),
  blobsKey: importBlobsKey(options.repo),
})

const graph = async (context: StepContext, state: ImportState): Promise<ImportState> => ({ ...(await fetchCommitGraph(stepped(context), state)), phase: 'fetch' })

const fetchStepped = async (context: StepContext, state: ImportState): Promise<ImportState> => {
  const { state: next, done } = await fetchNextStep(stepped(context), state)
  return done ? { ...next, phase: afterFetch(next) } : next
}

const lfsConfigOrder = (state: ImportState): [string, ObjectId][] => lfsRefOrder(state.targets, state.head)

const provisionalLfsEndpoint = (state: ImportState): ImportLfsEndpoint =>
  state.lfsUrl ? { url: normalizeLfsUrl(state.lfsUrl) ?? state.lfsUrl, source: 'setting' } : { url: lfsEndpointFor(state.url), source: 'default' }

const knownLfsEndpoint = async (odb: ObjectDatabase, state: ImportState): Promise<ImportLfsEndpoint | undefined> => {
  if (state.lfsUrl) return provisionalLfsEndpoint(state)
  const order = lfsConfigOrder(state)
  const present: [string, ObjectId][] = []
  for (const entry of order) {
    if (!(await odb.has(entry[1]))) break
    present.push(entry)
  }
  const found = await findLfsConfig(odb, present)
  if (found) return { url: found.url, source: 'lfsconfig', ref: found.ref }
  return present.length === order.length ? provisionalLfsEndpoint(state) : undefined
}

const resolveLfsEndpoint = async (odb: ObjectDatabase, state: ImportState): Promise<ImportLfsEndpoint> =>
  (await knownLfsEndpoint(odb, state)) ?? provisionalLfsEndpoint(state)

const mayAuthorize = (state: ImportState, endpoint: ImportLfsEndpoint): boolean => mayAuthorizeLfs(state.url, endpoint)

const dispatchLfs = async (context: StepContext, before: ImportState, after: ImportState): Promise<ImportState> => {
  const enqueue = context.options.enqueueLfs
  const found = after.lfsQueue.slice(before.lfsQueue.length)
  if (!enqueue || found.length === 0) return after
  const pending = before.lfsPending ?? []
  const known = new Set(pending.map((pointer) => pointer.oid))
  const fresh = found.filter((pointer) => !known.has(pointer.oid))
  const resolved = before.lfsEndpoint ?? (await knownLfsEndpoint(context.odb, after))
  const endpoint = resolved ?? provisionalLfsEndpoint(after)
  const redo = before.lfsEndpoint === undefined && endpoint.url !== provisionalLfsEndpoint(after).url ? pending : []
  let sent = 0
  try {
    for (const pointer of [...redo, ...fresh]) {
      await enqueue(pointer, endpoint)
      sent++
    }
  } catch {}
  const queued = Math.max(0, sent - redo.length)
  return {
    ...after,
    ...(resolved ? { lfsEndpoint: resolved } : {}),
    lfsQueue: [...before.lfsQueue, ...fresh.slice(queued)],
    lfsPending: [...pending, ...fresh.slice(0, queued)],
  }
}

const lfsBatch = (queue: readonly LfsPointer[], maxBytes: number): LfsPointer[] => {
  const batch: LfsPointer[] = []
  let bytes = 0
  for (const pointer of queue) {
    if (batch.length >= LFS_PER_STEP || (batch.length > 0 && bytes + pointer.size > maxBytes)) break
    batch.push(pointer)
    bytes += pointer.size
  }
  return batch
}

const lfsSequential = async (context: StepContext, state: ImportState): Promise<ImportState> => {
  const endpoint = state.lfsEndpoint ?? (await resolveLfsEndpoint(context.odb, state))
  const authorize = mayAuthorize(state, endpoint)
  const batch = lfsBatch(state.lfsQueue, context.options.maxLfsStepBytes ?? DEFAULT_MAX_LFS_STEP_BYTES)
  const result = await mirrorLfsObjects({
    storage: context.options.storage,
    repo: context.options.repo,
    remote: context.remote,
    endpoint: endpoint.url,
    authorize,
    objects: batch,
    ...(context.options.digests ? { digests: context.options.digests } : {}),
  })
  const next: ImportState = {
    ...state,
    lfsEndpoint: endpoint,
    lfsQueue: state.lfsQueue.slice(batch.length),
    lfsMissing: [...state.lfsMissing, ...result.missing],
  }
  return next.lfsQueue.length > 0 || (next.lfsPending?.length ?? 0) > 0 ? next : { ...next, phase: 'refs' }
}

const lfsWait = async (context: StepContext, state: ImportState, pending: readonly LfsPointer[]): Promise<ImportState> => {
  const { storage, repo, enqueueLfs } = context.options
  const endpoint = state.lfsEndpoint ?? (await resolveLfsEndpoint(context.odb, state))
  if (!enqueueLfs) return { ...state, lfsEndpoint: endpoint, lfsQueue: pending, lfsPending: [] }
  const now = context.now()
  const checked = pending.slice(0, LFS_PER_STEP)
  const missing: LfsPointer[] = []
  for (const pointer of checked) {
    const head = await storage.head(lfsObjectKey(repo, pointer.oid))
    if (!head || head.size !== pointer.size) missing.push(pointer)
  }
  const rest = [...pending.slice(checked.length), ...missing]
  const progressAt = missing.length < checked.length || !state.lfsProgressAt ? now.toISOString() : state.lfsProgressAt
  const next: ImportState = { ...state, lfsEndpoint: endpoint, lfsPending: rest, lfsProgressAt: progressAt }
  if (rest.length === 0) return { ...next, phase: 'refs' }
  const round = state.lfsRound ?? 0
  const moved = state.lfsEndpoint === undefined && endpoint.url !== provisionalLfsEndpoint(state).url
  if (!moved && now.getTime() - Date.parse(progressAt) < LFS_JOB_TIMEOUT_MS * 2 ** round) return next
  if (!moved && round + 1 >= LFS_JOB_ROUNDS) return { ...next, lfsQueue: rest, lfsPending: [] }
  for (const pointer of rest) await enqueueLfs(pointer, endpoint)
  return { ...next, lfsRound: moved ? round : round + 1, lfsProgressAt: now.toISOString() }
}

const lfs = (context: StepContext, state: ImportState): Promise<ImportState> => {
  const pending = state.lfsPending ?? []
  return state.lfsQueue.length > 0 || pending.length === 0 ? lfsSequential(context, state) : lfsWait(context, state, pending)
}

const updateRefs = async (context: StepContext, state: ImportState): Promise<ImportState> => {
  const { options, odb } = context
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await readRefs(options.storage, options.repo)
    if (!current) throw new ImportNotFoundError(`repository ${options.repo.owner}/${options.repo.name} not found`)
    const plan = await planImportRefUpdates(current.state.refs, state.targets, context.now(), (oldId, newId) => isAncestor(odb, oldId, newId))
    const adoptHead = Object.keys(current.state.refs).length === 0 && state.head !== undefined && state.targets[state.head] !== undefined
    const head = adoptHead ? (state.head as string) : current.state.head
    const done: ImportState = state.metadata ? { ...state, phase: 'metadata', updates: plan.updates } : { ...state, phase: 'done', updates: plan.updates, finishedAt: context.now().toISOString() }
    const next: RefsState = { ...current.state, head, refs: plan.refs }
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

const metadataPhase = async (context: StepContext, state: ImportState): Promise<ImportState> => {
  if (!context.options.importMetadata) throw new Error('this runtime cannot import issues, pull requests and releases')
  const { done, ...next } = await context.options.importMetadata(state)
  return done ? { ...state, metadata: next, phase: 'done', finishedAt: context.now().toISOString() } : { ...state, metadata: next }
}

const runPhase = (context: StepContext, state: ImportState): Promise<ImportState> => {
  switch (state.phase) {
    case 'discover':
      return discover(context, state)
    case 'graph':
      return graph(context, state)
    case 'fetch':
      return (state.stepped ? fetchStepped(context, state) : fetchWhole(context, state)).then((next) => dispatchLfs(context, state, next))
    case 'lfs':
      return lfs(context, state)
    case 'refs':
      return updateRefs(context, state)
    case 'metadata':
      return metadataPhase(context, state)
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
  readonly actor?: string
}

export type ImportScheduler = (job: ImportJob, delaySeconds: number) => Promise<void>

export type ImportLfsJob = ImportJob & { readonly kind: 'import-lfs'; readonly oid: string; readonly size: number; readonly endpoint: ImportLfsEndpoint }

export const retryDelaySeconds = (failures: number): number => (failures === 0 ? 0 : Math.min(15 * 2 ** (failures - 1), 600))

const waitSeconds = (until: string | undefined, now: Date): number => (until ? Math.min(Math.max(0, Math.ceil((Date.parse(until) - now.getTime()) / 1000)), 3600) : 0)

export const importDelaySeconds = (state: ImportState, now = new Date()): number =>
  state.failures > 0
    ? retryDelaySeconds(state.failures)
    : state.phase === 'lfs' && state.lfsQueue.length === 0 && (state.lfsPending?.length ?? 0) > 0
      ? LFS_POLL_SECONDS
      : state.phase === 'metadata'
        ? waitSeconds(state.metadata?.waitUntil, now)
        : 0

export const continueImport = async (
  job: ImportJob,
  options: Omit<ImportStepOptions, 'repo' | 'getAuthorization' | 'enqueueLfs' | 'importMetadata'> & {
    readonly schedule: ImportScheduler
    readonly scheduleLfs?: (job: ImportLfsJob) => Promise<void>
    readonly metadata?: (job: ImportJob, state: ImportState) => Promise<ImportMetadataResult>
  },
): Promise<ImportState> => {
  const { schedule, scheduleLfs, metadata, ...rest } = options
  const authorization = job.authorization
  const state = await importStep({
    ...rest,
    repo: { owner: job.owner, name: job.name },
    ...(authorization ? { getAuthorization: async () => authorization } : {}),
    ...(metadata ? { importMetadata: (state: ImportState) => metadata(job, state) } : {}),
    ...(scheduleLfs ? { enqueueLfs: (pointer: LfsPointer, endpoint: ImportLfsEndpoint) => scheduleLfs({ ...job, kind: 'import-lfs', oid: pointer.oid, size: pointer.size, endpoint }) } : {}),
  })
  if (!isImportFinished(state)) await schedule(job, importDelaySeconds(state, (rest.now ?? (() => new Date()))()))
  return state
}

export const importLfsObject = async (job: ImportLfsJob, options: Pick<ImportStepOptions, 'storage' | 'fetch' | 'digests'>): Promise<LfsMirrorResult | null> => {
  const repo = { owner: job.owner, name: job.name }
  const state = await readImportState(options.storage, repo)
  if (!state || isImportFinished(state) || !state.lfs) return null
  const authorization = job.authorization
  return mirrorLfsObjects({
    storage: options.storage,
    repo,
    remote: remoteFor({ ...(options.fetch ? { fetch: options.fetch } : {}), ...(authorization ? { getAuthorization: async () => authorization } : {}) }, state.url),
    endpoint: job.endpoint.url,
    authorize: mayAuthorize(state, job.endpoint),
    objects: [{ oid: job.oid, size: job.size }],
    ...(options.digests ? { digests: options.digests } : {}),
  })
}
