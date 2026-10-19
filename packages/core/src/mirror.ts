import { equalBytes, fromUtf8, readAll, toHex, utf8 } from './bytes.ts'
import type { DigestFactory } from './digest.ts'
import { fetchDumb, lsRefsDumb } from './dumb-client.ts'
import { type ObjectId, sha1 } from './hash.ts'
import { connectRemote, type Protocol, type ProtocolPreference, type RemoteConnection } from './fetch-client.ts'
import { LFS_POINTER_MAX_SIZE, lfsObjectKey, parseLfsPointer } from './lfs.ts'
import { type LfsEndpoint, mayAuthorizeLfs, resolveLfsEndpoint } from './lfs-config.ts'
import { lfsEndpointFor, type LfsMissing, type LfsMirrorResult, type LfsPointer, mirrorLfsObjects } from './lfs-mirror.ts'
import { type CopiedPack, copyPack, listRemotePacks } from './pack-copy.ts'
import { ByteCursor } from './cursor.ts'
import { indexPack } from './pack-indexer.ts'
import { isSubmodule, isTreeMode, parseCommit, parseTag, parseTree, references } from './objects.ts'
import { archiveName, UPSTREAM_PREFIX, validRefName } from './receive-pack.ts'
import { type AuthorizationSupplier, expectOk, type FetchFunction, type Remote, type RemoteRef, remoteRequest, remoteUrl } from './remote.ts'
import {
  isValidName,
  ObjectDatabase,
  advertisedRefs,
  type MirrorView,
  mirrorViewRefs,
  packKey,
  readRefs,
  type RefsState,
  registerPacks,
  type RepositoryName,
  repositoryPrefix,
  stagingPrefix,
  writeRefs,
  writeServerInfo,
} from './repository.ts'
import { fetchFeatures } from './smart-client.ts'
import { fetchCommitGraph, fetchNextStep, initialProgress, type SteppedFetchLimits, type SteppedProgress } from './stepped-fetch.ts'
import type { Storage } from './storage.ts'
import { isAncestor, MissingObjectError, type ObjectSource } from './walk.ts'

export type MirrorMode = 'auto' | 'manual'

export type MirrorAuth = 'none' | 'instance' | 'token'

export type MirrorConfig = {
  readonly version: 1
  readonly remote: string
  readonly url: string
  readonly mode: MirrorMode
  readonly namespace: string
  readonly lfs: boolean
  readonly lfsUrl?: string
  readonly auth?: MirrorAuth
  readonly createdAt: string
  readonly detachedAt?: string
}

export type MirrorAlarm = {
  readonly kind: 'history-rewritten' | 'ref-deleted'
  readonly ref: string
  readonly localRef: string
  readonly oldId: ObjectId
  readonly newId: ObjectId | null
  readonly archivedAs: string
  readonly at: string
}

export type MirrorRun = {
  readonly startedAt: string
  readonly finishedAt?: string
  readonly ok?: boolean
  readonly error?: string
}

export type DeepCheck = {
  readonly at: string
  readonly ok: boolean
  readonly packs: number
  readonly objects: number
  readonly problems: readonly string[]
}

export type PendingPack = {
  readonly name: string
  readonly size: number | null
  readonly oversized: boolean
}

export type MirrorStatus = {
  readonly version: 1
  readonly remote: string
  readonly lastRun?: MirrorRun
  readonly lastSuccessAt?: string
  readonly protocol?: Protocol
  readonly upstreamHead?: string
  readonly upstreamRefs?: number
  readonly upstreamChecksum?: string
  readonly lfsPending: readonly LfsMissing[]
  readonly lfsScan?: readonly string[]
  readonly alarms: readonly MirrorAlarm[]
  readonly lastDeepCheck?: DeepCheck
  readonly pendingPacks?: readonly PendingPack[]
  readonly lfsEndpoint?: LfsEndpoint
}

export type MirrorFetchState = SteppedProgress & {
  readonly version: 1
  readonly phase: 'graph' | 'fetch' | 'done' | 'failed'
  readonly startedAt: string
  readonly updatedAt: string
  readonly refs: Readonly<Record<string, ObjectId>>
  readonly head?: string
  readonly steps: number
  readonly failures: number
  readonly error?: string
}

export type RefUpdate = {
  readonly ref: string
  readonly oldId: ObjectId | null
  readonly newId: ObjectId | null
  readonly kind: 'created' | 'fast-forward' | 'forced' | 'deleted'
}

export const DEFAULT_REMOTE = 'origin'

export const MAX_STORED_ALARMS = 100

export class MirrorNotFoundError extends Error {}

export class MirrorExistsError extends Error {}

const mirrorPrefix = (repo: RepositoryName, remote: string) => `${repositoryPrefix(repo)}mirrors/${remote}/`

export const mirrorConfigKey = (repo: RepositoryName, remote: string): string => `${mirrorPrefix(repo, remote)}config.json`

export const mirrorStatusKey = (repo: RepositoryName, remote: string): string => `${mirrorPrefix(repo, remote)}status.json`

export const mirrorFetchKey = (repo: RepositoryName, remote: string): string => `${mirrorPrefix(repo, remote)}fetch.json`

export const MAX_MIRROR_FETCH_FAILURES = 5

export const upstreamRefPrefix = (remote: string): string => `${UPSTREAM_PREFIX}${remote}/`

const readJson = async <T>(storage: Storage, key: string): Promise<{ value: T; etag: string } | null> => {
  const stored = await storage.get(key)
  return stored ? { value: JSON.parse(fromUtf8(await readAll(stored.body))) as T, etag: stored.etag } : null
}

const writeJson = async (storage: Storage, key: string, value: unknown, condition: { ifMatch?: string; ifNoneMatch?: '*' } = {}) => {
  const bytes = utf8(`${JSON.stringify(value, null, 2)}\n`)
  return storage.put(key, bytes, bytes.length, { ...condition, contentType: 'application/json' })
}

export type MirrorSettings = {
  readonly remote?: string
  readonly url: string
  readonly mode?: MirrorMode
  readonly namespace?: string
  readonly lfs?: boolean
  readonly lfsUrl?: string
  readonly auth?: MirrorAuth
}

const validNamespace = (namespace: string): boolean => /^([A-Za-z0-9_][A-Za-z0-9._-]*\/)*$/.test(namespace) && !namespace.includes('..') && !/\.lock\//.test(namespace)

const validUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

export const configureMirror = async (storage: Storage, repo: RepositoryName, settings: MirrorSettings, now = new Date()): Promise<MirrorConfig> => {
  const remote = settings.remote ?? DEFAULT_REMOTE
  const namespace = settings.namespace ?? ''
  if (!isValidName(remote)) throw new Error(`invalid remote name ${remote}`)
  if (!validUrl(settings.url)) throw new Error(`invalid upstream URL ${settings.url}`)
  if (settings.lfsUrl && !validUrl(settings.lfsUrl)) throw new Error(`invalid LFS URL ${settings.lfsUrl}`)
  if (!validNamespace(namespace)) throw new Error(`invalid upstream namespace ${namespace}`)
  if (settings.auth !== undefined && settings.auth !== 'none' && settings.auth !== 'instance' && settings.auth !== 'token') throw new Error(`invalid mirror auth ${String(settings.auth)}`)
  if (!(await readRefs(storage, repo))) throw new Error(`repository ${repo.owner}/${repo.name} not found`)
  const config: MirrorConfig = {
    version: 1,
    remote,
    url: settings.url,
    mode: settings.mode ?? 'auto',
    namespace,
    lfs: settings.lfs ?? true,
    ...(settings.lfsUrl ? { lfsUrl: settings.lfsUrl } : {}),
    ...(settings.auth && settings.auth !== 'none' ? { auth: settings.auth } : {}),
    createdAt: now.toISOString(),
  }
  const result = await writeJson(storage, mirrorConfigKey(repo, remote), config, { ifNoneMatch: '*' })
  if (!result.ok) throw new MirrorExistsError(`mirror ${remote} already configured`)
  return config
}

export const readMirrorConfig = async (storage: Storage, repo: RepositoryName, remote = DEFAULT_REMOTE): Promise<MirrorConfig | null> =>
  (await readJson<MirrorConfig>(storage, mirrorConfigKey(repo, remote)))?.value ?? null

export const readMirrorStatus = async (storage: Storage, repo: RepositoryName, remote = DEFAULT_REMOTE): Promise<MirrorStatus | null> =>
  (await readJson<MirrorStatus>(storage, mirrorStatusKey(repo, remote)))?.value ?? null

export const listMirrors = async (storage: Storage, repo: RepositoryName): Promise<MirrorConfig[]> => {
  const configs: MirrorConfig[] = []
  for await (const info of storage.list(`${repositoryPrefix(repo)}mirrors/`)) {
    if (!info.key.endsWith('/config.json')) continue
    const stored = await readJson<MirrorConfig>(storage, info.key)
    if (stored) configs.push(stored.value)
  }
  return configs
}

const updateConfig = async (
  storage: Storage,
  repo: RepositoryName,
  remote: string,
  change: (config: MirrorConfig) => MirrorConfig,
): Promise<MirrorConfig> => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const stored = await readJson<MirrorConfig>(storage, mirrorConfigKey(repo, remote))
    if (!stored) throw new MirrorNotFoundError(`mirror ${remote} not configured`)
    const next = change(stored.value)
    if ((await writeJson(storage, mirrorConfigKey(repo, remote), next, { ifMatch: stored.etag })).ok) return next
  }
  throw new Error(`could not update mirror ${remote}`)
}

export const setMirrorMode = (storage: Storage, repo: RepositoryName, mode: MirrorMode, remote = DEFAULT_REMOTE): Promise<MirrorConfig> =>
  updateConfig(storage, repo, remote, (config) => ({ ...config, mode }))

export const materializeMirrorView = async (storage: Storage, repo: RepositoryName, remote: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await readRefs(storage, repo)
    if (!current) throw new Error(`repository ${repo.owner}/${repo.name} not found`)
    if (current.state.mirrorView?.remote !== remote) return false
    const advertised = advertisedRefs(current.state)
    const state: RefsState = { head: advertised.head, refs: { ...current.state.refs, ...mirrorViewRefs(current.state) } }
    if (await writeRefs(storage, repo, state, current.etag)) {
      await writeServerInfo(storage, repo, state, new ObjectDatabase(storage, repo))
      return true
    }
  }
  throw new Error('could not materialize the mirror view')
}

export const detachMirror = async (storage: Storage, repo: RepositoryName, remote = DEFAULT_REMOTE, now = new Date()): Promise<MirrorConfig> => {
  const config = await updateConfig(storage, repo, remote, (current) => (current.detachedAt ? current : { ...current, detachedAt: now.toISOString() }))
  await materializeMirrorView(storage, repo, remote)
  return config
}

export const isMirrorDue = (config: MirrorConfig, status: MirrorStatus | null, now: Date, intervalMs: number, staleRunMs = 6 * 60 * 60 * 1000): boolean => {
  if (config.mode !== 'auto' || config.detachedAt) return false
  const run = status?.lastRun
  if (!run) return true
  const started = Date.parse(run.startedAt)
  if (!run.finishedAt) return now.getTime() - started >= staleRunMs
  return now.getTime() - started >= intervalMs
}

export const refsChecksum = (refs: Iterable<readonly [string, ObjectId]>): string => {
  const acc = new Uint8Array(20)
  for (const [name, id] of refs) {
    const digest = sha1(utf8(`${name}${id}`))
    for (let i = 0; i < 20; i++) acc[i] = (acc[i] as number) ^ (digest[i] as number)
  }
  return toHex(acc)
}

export type UpstreamRefs = {
  readonly refs: ReadonlyMap<string, ObjectId>
  readonly head?: string
  readonly ignored: readonly string[]
}

export const selectUpstreamRefs = (listed: readonly RemoteRef[], namespace: string, head?: string): UpstreamRefs => {
  const source = `refs/${namespace}`
  const refs = new Map<string, ObjectId>()
  const ignored: string[] = []
  for (const ref of listed) {
    if (!ref.name.startsWith(source)) continue
    const canonical = `refs/${ref.name.slice(source.length)}`
    if (!canonical.startsWith('refs/heads/') && !canonical.startsWith('refs/tags/')) continue
    if (!validRefName(canonical)) {
      ignored.push(ref.name)
      continue
    }
    refs.set(canonical, ref.id)
  }
  const canonicalHead = head?.startsWith(source) ? `refs/${head.slice(source.length)}` : undefined
  return { refs, ignored, ...(canonicalHead ? { head: canonicalHead } : {}) }
}

export const localUpstreamRef = (remote: string, canonical: string): string => `${upstreamRefPrefix(remote)}${canonical.slice('refs/'.length)}`

export type RefPlan = {
  readonly refs: Record<string, ObjectId>
  readonly updates: readonly RefUpdate[]
  readonly alarms: readonly MirrorAlarm[]
}

export const planRefUpdates = async (
  current: Readonly<Record<string, ObjectId>>,
  remote: string,
  upstream: ReadonlyMap<string, ObjectId>,
  at: Date,
  isFastForward: (oldId: ObjectId, newId: ObjectId) => Promise<boolean>,
): Promise<RefPlan> => {
  const prefix = upstreamRefPrefix(remote)
  const refs: Record<string, ObjectId> = { ...current }
  const updates: RefUpdate[] = []
  const alarms: MirrorAlarm[] = []
  const mapped = new Set<string>()
  const archive = (kind: MirrorAlarm['kind'], canonical: string, local: string, oldId: ObjectId, newId: ObjectId | null) => {
    const archivedAs = archiveName(local, at)
    refs[archivedAs] = oldId
    alarms.push({ kind, ref: canonical, localRef: local, oldId, newId, archivedAs, at: at.toISOString() })
  }
  for (const [canonical, id] of [...upstream].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const local = localUpstreamRef(remote, canonical)
    mapped.add(local)
    const oldId = current[local]
    if (oldId === id) continue
    refs[local] = id
    if (oldId === undefined) {
      updates.push({ ref: local, oldId: null, newId: id, kind: 'created' })
      continue
    }
    const fastForward = canonical.startsWith('refs/heads/') && (await isFastForward(oldId, id))
    if (!fastForward) archive('history-rewritten', canonical, local, oldId, id)
    updates.push({ ref: local, oldId, newId: id, kind: fastForward ? 'fast-forward' : 'forced' })
  }
  for (const [local, oldId] of Object.entries(current).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!local.startsWith(prefix) || mapped.has(local)) continue
    delete refs[local]
    archive('ref-deleted', `refs/${local.slice(prefix.length)}`, local, oldId, null)
    updates.push({ ref: local, oldId, newId: null, kind: 'deleted' })
  }
  return { refs, updates, alarms }
}

const peelToCommit = async (source: ObjectSource, id: ObjectId, visit: (id: ObjectId) => void): Promise<ObjectId | null> => {
  let current = id
  for (let depth = 0; depth < 10; depth++) {
    const object = await source.read(current)
    if (!object) throw new MissingObjectError(current)
    if (object.type === 'commit') return current
    visit(current)
    if (object.type !== 'tag') return null
    current = parseTag(object.data).object
  }
  return null
}

export const commitClosure = async (source: ObjectSource, tips: Iterable<ObjectId>): Promise<Set<ObjectId>> => {
  const closure = new Set<ObjectId>()
  const stack: ObjectId[] = []
  for (const tip of new Set(tips)) {
    if (closure.has(tip)) continue
    const commit = await peelToCommit(source, tip, (id) => closure.add(id))
    if (commit) stack.push(commit)
  }
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId
    if (closure.has(id)) continue
    closure.add(id)
    const object = await source.read(id)
    if (!object) throw new MissingObjectError(id)
    stack.push(...parseCommit(object.data).parents)
  }
  return closure
}

export type NewObjectScan = {
  readonly objects: number
  readonly commits: number
  readonly lfs: readonly LfsPointer[]
}

const knownTrees = async (odb: ObjectDatabase, trees: Iterable<ObjectId>): Promise<Set<ObjectId>> => {
  const known = new Set<ObjectId>()
  const stack = [...trees]
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId
    if (known.has(id)) continue
    known.add(id)
    const object = await odb.read(id)
    if (!object) throw new MissingObjectError(id)
    for (const entry of parseTree(object.data)) {
      if (isSubmodule(entry)) continue
      if (isTreeMode(entry.mode)) stack.push(entry.id)
      else known.add(entry.id)
    }
  }
  return known
}

export const scanNewObjects = async (
  odb: ObjectDatabase,
  tips: readonly ObjectId[],
  connected: ReadonlySet<ObjectId>,
  findLfs: boolean,
): Promise<NewObjectScan> => {
  const boundary = new Set<ObjectId>()
  const commits = new Set<ObjectId>()
  const commitStack: ObjectId[] = []
  for (const tip of tips) {
    if (connected.has(tip)) continue
    const commit = await peelToCommit(odb, tip, () => undefined)
    if (commit) commitStack.push(commit)
  }
  while (commitStack.length > 0) {
    const id = commitStack.pop() as ObjectId
    if (commits.has(id) || connected.has(id)) continue
    commits.add(id)
    const object = await odb.read(id)
    if (!object) throw new MissingObjectError(id)
    for (const parent of parseCommit(object.data).parents) {
      if (connected.has(parent)) boundary.add(parent)
      else commitStack.push(parent)
    }
  }
  const boundaryTrees: ObjectId[] = []
  for (const id of boundary) {
    const object = await odb.read(id)
    if (object) boundaryTrees.push(parseCommit(object.data).tree)
  }
  const known = await knownTrees(odb, boundaryTrees)
  const lfs: LfsPointer[] = []
  const seen = new Set<ObjectId>()
  const stack = [...tips]
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId
    if (seen.has(id) || connected.has(id) || known.has(id)) continue
    seen.add(id)
    const object = await odb.read(id)
    if (!object) throw new MissingObjectError(id)
    if (object.type === 'blob') {
      if (findLfs && object.data.length <= LFS_POINTER_MAX_SIZE) {
        const pointer = parseLfsPointer(object.data)
        if (pointer) lfs.push(pointer)
      }
      continue
    }
    stack.push(...references(object))
  }
  return { objects: seen.size, commits: commits.size, lfs }
}

const isComplete = async (odb: ObjectDatabase, tips: readonly ObjectId[], connected: ReadonlySet<ObjectId>): Promise<boolean> => {
  try {
    await scanNewObjects(odb, tips, connected, false)
    return true
  } catch (error) {
    if (error instanceof MissingObjectError) return false
    throw error
  }
}

export type SyncStrategy = 'fetch' | 'copy' | 'auto'

export type SyncOptions = {
  readonly storage: Storage
  readonly strategy?: SyncStrategy
  readonly digests?: DigestFactory
  readonly deferLfs?: boolean
  readonly repo: RepositoryName
  readonly remote?: string
  readonly fetch?: FetchFunction
  readonly getAuthorization?: AuthorizationSupplier
  readonly now?: () => Date
  readonly protocol?: ProtocolPreference
  readonly maxPackBytes?: number
  readonly maxSteps?: number
  readonly commitsPerStep?: number
  readonly stepLimits?: SteppedFetchLimits
}

export type SyncResult = {
  readonly status: 'ok' | 'detached' | 'failed' | 'pending'
  readonly strategy?: Exclude<SyncStrategy, 'auto'>
  readonly protocol?: Protocol
  readonly copied?: { readonly packs: number; readonly bytes: number; readonly reused: number }
  readonly fetched: { readonly objects: number; readonly packs: readonly string[]; readonly rounds: number }
  readonly scanned: { readonly objects: number; readonly commits: number }
  readonly updates: readonly RefUpdate[]
  readonly alarms: readonly MirrorAlarm[]
  readonly lfs: LfsMirrorResult | null
  readonly upstreamHead?: string
  readonly upstreamChecksum?: string
  readonly error?: string
}

const emptyResult = (status: SyncResult['status']): SyncResult => ({
  status,
  fetched: { objects: 0, packs: [], rounds: 0 },
  scanned: { objects: 0, commits: 0 },
  updates: [],
  alarms: [],
  lfs: null,
})

const remoteOf = (config: MirrorConfig, options: Pick<SyncOptions, 'fetch' | 'getAuthorization'>): Remote => ({
  url: config.url,
  ...(options.fetch ? { fetch: options.fetch } : {}),
  ...(options.getAuthorization ? { getAuthorization: options.getAuthorization } : {}),
})

const deferred = (pending: readonly LfsMissing[], found: readonly LfsPointer[]): LfsMissing[] => {
  const byOid = new Map<string, LfsMissing>(pending.map((pointer) => [pointer.oid, pointer]))
  for (const pointer of found) if (!byOid.has(pointer.oid)) byOid.set(pointer.oid, { oid: pointer.oid, size: pointer.size, reason: 'deferred' })
  return [...byOid.values()]
}

const saveStatus = async (storage: Storage, repo: RepositoryName, remote: string, change: (status: MirrorStatus) => MirrorStatus) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const stored = await readJson<MirrorStatus>(storage, mirrorStatusKey(repo, remote))
    const base: MirrorStatus = stored?.value ?? { version: 1, remote, lfsPending: [], alarms: [] }
    const result = await writeJson(storage, mirrorStatusKey(repo, remote), change(base), stored ? { ifMatch: stored.etag } : { ifNoneMatch: '*' })
    if (result.ok) return
  }
  throw new Error(`could not save mirror status for ${remote}`)
}

type FetchOutcome = {
  readonly protocol: Protocol
  readonly upstream: UpstreamRefs | null
  readonly lfs: readonly LfsPointer[]
  readonly fetched: SyncResult['fetched']
  readonly scanned: SyncResult['scanned']
}

const supportsFilter = (connection: RemoteConnection): boolean =>
  connection.protocol === 'v2' && connection.capabilities !== undefined && fetchFeatures(connection.capabilities).has('filter')

const fetchOnce = async (options: SyncOptions, config: MirrorConfig, odb: ObjectDatabase, connection: RemoteConnection, upstream: UpstreamRefs, localTips: readonly ObjectId[], connected: ReadonlySet<ObjectId>, newTips: readonly ObjectId[]): Promise<FetchOutcome> => {
  let fetched: SyncResult['fetched'] = { objects: 0, packs: [], rounds: 0 }
  if (newTips.length > 0 && !(await isComplete(odb, newTips, connected))) {
    fetched = await connection.fetchObjects(odb, {
      wants: newTips,
      haveTips: localTips,
      isConnected: (id) => connected.has(id),
      ...(options.maxPackBytes !== undefined ? { maxPackBytes: options.maxPackBytes } : {}),
    })
  }
  const scan = await scanNewObjects(odb, newTips, connected, config.lfs)
  return { protocol: connection.protocol, upstream, lfs: scan.lfs, fetched, scanned: { objects: scan.objects, commits: scan.commits } }
}

const fetchFromRemote = async (options: SyncOptions, config: MirrorConfig, remote: Remote, odb: ObjectDatabase, localRefs: Readonly<Record<string, ObjectId>>): Promise<FetchOutcome> => {
  const { storage, repo } = options
  const now = options.now ?? (() => new Date())
  const key = mirrorFetchKey(repo, config.remote)
  const stored = await readJson<MirrorFetchState>(storage, key)
  let etag = stored?.etag ?? null
  let state = stored && (stored.value.phase === 'graph' || stored.value.phase === 'fetch') ? stored.value : null
  if (!state) {
    const connection = await connectRemote(remote, options.protocol ?? 'auto')
    const source = `refs/${config.namespace}`
    const listing = await connection.listRefs([`${source}heads/`, `${source}tags/`])
    const upstream = selectUpstreamRefs(listing.refs, config.namespace, listing.head)
    const localTips = [...new Set(Object.values(localRefs))]
    const connected = await commitClosure(odb, localTips)
    const newTips = [...new Set(upstream.refs.values())].filter((id) => !connected.has(id))
    if (newTips.length === 0 || !supportsFilter(connection) || (await isComplete(odb, newTips, connected))) {
      return fetchOnce(options, config, odb, connection, upstream, localTips, connected, newTips)
    }
    const at = now().toISOString()
    state = {
      ...initialProgress(config.lfs, options.commitsPerStep),
      version: 1,
      phase: 'graph',
      startedAt: at,
      updatedAt: at,
      refs: Object.fromEntries(upstream.refs),
      ...(upstream.head ? { head: upstream.head } : {}),
      wants: newTips,
      localTips,
      steps: 0,
      failures: 0,
    }
  }
  const stepped = { ...options.stepLimits, storage, repo, odb, remote, commitsKey: `${mirrorPrefix(repo, config.remote)}commits.txt`, blobsKey: `${mirrorPrefix(repo, config.remote)}blobs.txt` }
  const save = async (next: MirrorFetchState): Promise<boolean> => {
    const written = await writeJson(storage, key, next, etag ? { ifMatch: etag } : { ifNoneMatch: '*' })
    if (written.ok) etag = written.info.etag
    return written.ok
  }
  for (let steps = 0; (state.phase === 'graph' || state.phase === 'fetch') && steps < (options.maxSteps ?? Number.POSITIVE_INFINITY); steps++) {
    let next: MirrorFetchState
    try {
      if (state.phase === 'graph') next = { ...(await fetchCommitGraph(stepped, state)), phase: 'fetch' }
      else {
        const step = await fetchNextStep(stepped, state)
        next = step.done ? { ...step.state, phase: 'done' } : step.state
      }
      const { error: _error, ...clean } = next
      next = { ...clean, failures: 0 }
    } catch (error) {
      const failures = state.failures + 1
      await save({ ...state, failures, error: error instanceof Error ? error.message : String(error), updatedAt: now().toISOString(), ...(failures >= MAX_MIRROR_FETCH_FAILURES ? { phase: 'failed' as const } : {}) })
      throw error
    }
    next = { ...next, steps: state.steps + 1, updatedAt: now().toISOString() }
    if (!(await save(next))) return { protocol: 'v2', upstream: null, lfs: [], fetched: { objects: 0, packs: [], rounds: 0 }, scanned: { objects: 0, commits: 0 } }
    state = next
  }
  const fetched = { objects: state.fetched.objects, packs: [], rounds: state.steps }
  const scanned = { objects: state.fetched.objects, commits: state.commits }
  if (state.phase !== 'done') return { protocol: 'v2', upstream: null, lfs: [], fetched, scanned }
  return { protocol: 'v2', upstream: { refs: new Map(Object.entries(state.refs)), ignored: [], ...(state.head ? { head: state.head } : {}) }, lfs: state.lfsQueue, fetched, scanned }
}

export const syncMirror = async (options: SyncOptions): Promise<SyncResult> => {
  const { storage, repo } = options
  const remoteName = options.remote ?? DEFAULT_REMOTE
  const now = options.now ?? (() => new Date())
  const config = await readMirrorConfig(storage, repo, remoteName)
  if (!config) throw new MirrorNotFoundError(`mirror ${remoteName} not configured for ${repo.owner}/${repo.name}`)
  if (config.detachedAt) return emptyResult('detached')
  const startedAt = now().toISOString()
  await saveStatus(storage, repo, remoteName, (status) => ({ ...status, lastRun: { startedAt } }))
  const previous = await readMirrorStatus(storage, repo, remoteName)
  let result = emptyResult('failed')
  try {
    const remote = remoteOf(config, options)
    const local = await readRefs(storage, repo)
    if (!local) throw new Error(`repository ${repo.owner}/${repo.name} not found`)
    const odb = new ObjectDatabase(storage, repo)
    let upstream: UpstreamRefs
    let protocol: Protocol
    let lfsFound: readonly LfsPointer[]
    const remotePacks = options.strategy === 'copy' || options.strategy === 'auto' ? await listRemotePacks(remote) : null
    if (options.strategy === 'copy' || remotePacks !== null) {
      const copied = await copyUpstreamPacks(remote, storage, repo, odb, config, remotePacks ?? [], options, remoteName)
      upstream = copied.upstream
      protocol = 'dumb'
      lfsFound = copied.lfs
      result = { ...result, strategy: 'copy', protocol, fetched: copied.fetched, copied: copied.copied }
    } else {
      const outcome = await fetchFromRemote(options, config, remote, odb, local.state.refs)
      result = { ...result, strategy: 'fetch', protocol: outcome.protocol, fetched: outcome.fetched, scanned: outcome.scanned }
      if (!outcome.upstream) return { ...result, status: 'pending' }
      protocol = outcome.protocol
      upstream = outcome.upstream
      lfsFound = outcome.lfs
    }
    const upstreamChecksum = refsChecksum(upstream.refs)
    result = { ...result, upstreamChecksum, ...(upstream.head ? { upstreamHead: upstream.head } : {}) }
    let lfsEndpoint = previous?.lfsEndpoint
    const attempted = new Set<string>()
    let lfsMissing: readonly LfsMissing[] = []
    if (config.lfs) {
      const queue = await recordLfsPointers(storage, repo, remoteName, odb, result.fetched.packs, lfsFound)
      if (queue.length > 0) {
        lfsEndpoint = await resolveLfsEndpoint(odb, config.url, config.lfsUrl, Object.fromEntries(upstream.refs), upstream.head)
        if (!options.deferLfs) {
          for (const pointer of queue) attempted.add(pointer.oid)
          const lfs = await mirrorLfsObjects({
            storage,
            repo,
            remote,
            endpoint: lfsEndpoint.url,
            authorize: mayAuthorizeLfs(config.url, lfsEndpoint),
            ...(options.digests ? { digests: options.digests } : {}),
            objects: queue.map(({ oid, size }) => ({ oid, size })),
          })
          lfsMissing = lfs.missing
          result = { ...result, lfs }
        }
      }
    }
    const plan = await updateUpstreamRefs(storage, repo, odb, remoteName, upstream.refs, upstream.head, now())
    result = { ...result, status: 'ok', updates: plan.updates, alarms: plan.alarms }
    const finishedAt = now().toISOString()
    await saveStatus(storage, repo, remoteName, (status) => ({
      ...status,
      lastRun: { startedAt, finishedAt, ok: true },
      lastSuccessAt: finishedAt,
      protocol,
      ...(upstream.head ? { upstreamHead: upstream.head } : {}),
      upstreamRefs: upstream.refs.size,
      upstreamChecksum,
      lfsPending: [...status.lfsPending.filter((pointer) => !attempted.has(pointer.oid)), ...lfsMissing],
      ...(lfsEndpoint ? { lfsEndpoint } : {}),
      pendingPacks: [],
      alarms: [...status.alarms, ...plan.alarms].slice(-MAX_STORED_ALARMS),
    }))
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await saveStatus(storage, repo, remoteName, (status) => ({
      ...status,
      lastRun: { startedAt, finishedAt: now().toISOString(), ok: false, error: message },
    }))
    return { ...result, status: 'failed', error: message }
  }
}

const recordLfsPointers = async (
  storage: Storage,
  repo: RepositoryName,
  remote: string,
  odb: ObjectDatabase,
  scanned: readonly string[],
  found: readonly LfsPointer[],
): Promise<readonly LfsMissing[]> => {
  const status = await readMirrorStatus(storage, repo, remote)
  const local = new Set(await odb.packNames())
  const unscanned = (status?.lfsScan ?? []).filter((name) => !scanned.includes(name) && local.has(name))
  const pointers = [...found]
  for (const name of unscanned) {
    for (const blob of await odb.smallBlobs(name, LFS_POINTER_MAX_SIZE)) {
      const pointer = parseLfsPointer(blob.data)
      if (pointer) pointers.push(pointer)
    }
  }
  if (pointers.length === 0 && (status?.lfsScan ?? []).length === 0) return status?.lfsPending ?? []
  const done = new Set([...scanned, ...unscanned])
  let queue: readonly LfsMissing[] = []
  await saveStatus(storage, repo, remote, (current) => {
    const { lfsScan, ...rest } = current
    const left = (lfsScan ?? []).filter((name) => !done.has(name))
    queue = deferred(current.lfsPending, pointers)
    return { ...rest, lfsPending: queue, ...(left.length > 0 ? { lfsScan: left } : {}) }
  })
  return queue
}

const nextMirrorView = (current: MirrorView | undefined, remote: string, upstreamHead: string | undefined): MirrorView | undefined => {
  if (current && current.remote !== remote) return current
  const head = upstreamHead ?? current?.head
  return { remote, ...(head ? { head } : {}) }
}

const updateUpstreamRefs = async (
  storage: Storage,
  repo: RepositoryName,
  odb: ObjectDatabase,
  remote: string,
  upstream: ReadonlyMap<string, ObjectId>,
  upstreamHead: string | undefined,
  at: Date,
): Promise<RefPlan> => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await readRefs(storage, repo)
    if (!current) throw new Error(`repository ${repo.owner}/${repo.name} not found`)
    const plan = await planRefUpdates(current.state.refs, remote, upstream, at, (oldId, newId) => isAncestor(odb, oldId, newId))
    const view = nextMirrorView(current.state.mirrorView, remote, upstreamHead)
    const viewChanged = view?.remote !== current.state.mirrorView?.remote || view?.head !== current.state.mirrorView?.head
    if (plan.updates.length === 0 && !viewChanged) {
      await writeServerInfo(storage, repo, current.state, odb)
      return plan
    }
    const state: RefsState = { ...current.state, refs: plan.refs, ...(view ? { mirrorView: view } : {}) }
    if (await writeRefs(storage, repo, state, current.etag)) {
      await writeServerInfo(storage, repo, state, odb)
      return plan
    }
  }
  throw new Error('could not update refs')
}

type CopyOutcome = {
  readonly upstream: UpstreamRefs
  readonly fetched: SyncResult['fetched']
  readonly copied: NonNullable<SyncResult['copied']>
  readonly lfs: readonly LfsPointer[]
}

const copyUpstreamPacks = async (
  remote: Remote,
  storage: Storage,
  repo: RepositoryName,
  odb: ObjectDatabase,
  config: MirrorConfig,
  remotePacks: readonly string[],
  options: Pick<SyncOptions, 'maxPackBytes' | 'digests'>,
  remoteName: string,
): Promise<CopyOutcome> => {
  const { maxPackBytes } = options
  const listing = await lsRefsDumb(remote)
  const upstream = selectUpstreamRefs(listing.refs, config.namespace, listing.head)
  const local = new Set(await odb.packNames())
  const missing = remotePacks.filter((name) => !local.has(name))
  const copied = []
  for (const name of missing) {
    copied.push(
      await copyPack({ remote, storage, repo, name, ...(maxPackBytes !== undefined ? { maxPackBytes } : {}), ...(options.digests ? { digests: options.digests } : {}) }),
    )
  }
  const names = copied.map((pack) => pack.name)
  if (config.lfs && names.length > 0) await saveStatus(storage, repo, remoteName, (status) => ({ ...status, lfsScan: [...new Set([...(status.lfsScan ?? []), ...names])] }))
  if (names.length > 0) await registerPacks(storage, repo, names)
  odb.invalidate()
  const absent: ObjectId[] = []
  for (const tip of new Set(upstream.refs.values())) if (!(await odb.has(tip))) absent.push(tip)
  const packs = [...names]
  let objects = copied.reduce((sum, pack) => sum + pack.objects, 0)
  if (absent.length > 0) {
    const fallback = await fetchDumb(remote, odb, { wants: absent, isConnected: () => false, ...(maxPackBytes !== undefined ? { maxPackBytes } : {}) })
    packs.push(...fallback.packs)
    objects += fallback.objects
  }
  const lfs: LfsPointer[] = []
  if (config.lfs) {
    for (const name of packs) {
      for (const blob of await odb.smallBlobs(name, LFS_POINTER_MAX_SIZE)) {
        const pointer = parseLfsPointer(blob.data)
        if (pointer) lfs.push(pointer)
      }
    }
  }
  return {
    upstream,
    fetched: { objects, packs, rounds: 0 },
    copied: { packs: copied.filter((pack) => !pack.reused).length, bytes: copied.reduce((sum, pack) => sum + (pack.reused ? 0 : pack.bytes), 0), reused: copied.filter((pack) => pack.reused).length },
    lfs,
  }
}

const missingLfsObjects = async (storage: Storage, repo: RepositoryName, odb: ObjectDatabase, names: readonly string[]): Promise<LfsPointer[]> => {
  const missing = new Map<string, LfsPointer>()
  for (const name of names) {
    for (const blob of await odb.smallBlobs(name, LFS_POINTER_MAX_SIZE)) {
      const pointer = parseLfsPointer(blob.data)
      if (!pointer || missing.has(pointer.oid)) continue
      const stored = await storage.head(lfsObjectKey(repo, pointer.oid))
      if (!stored || stored.size !== pointer.size) missing.set(pointer.oid, pointer)
    }
  }
  return [...missing.values()]
}

export const deepCheckRepository = async (storage: Storage, repo: RepositoryName, at = new Date(), lfs = true): Promise<DeepCheck & { readonly lfsMissing: readonly LfsPointer[] }> => {
  const odb = new ObjectDatabase(storage, repo)
  const problems: string[] = []
  const names = await odb.packNames()
  let objects = 0
  for (const name of names) {
    try {
      const index = await storage.get(packKey(repo, name.replace(/\.pack$/, '.idx')))
      const pack = await storage.get(packKey(repo, name))
      if (!index || !pack) throw new Error('pack or index is missing')
      const indexed = await indexPack(new ByteCursor(pack.body), { storage, stagingPrefix: stagingPrefix(repo), objects: odb, checkReferences: false })
      if (!equalBytes(indexed.indexBytes(), await readAll(index.body))) problems.push(`${name}: index differs from the recomputed index`)
      objects += indexed.objectCount
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const refs = await readRefs(storage, repo)
  try {
    await scanNewObjects(odb, [...new Set(Object.values(refs?.state.refs ?? {}))], new Set(), false)
  } catch (error) {
    if (!(error instanceof MissingObjectError)) throw error
    problems.push(error.message)
  }
  const lfsMissing = lfs ? await missingLfsObjects(storage, repo, odb, names) : []
  for (const pointer of lfsMissing) problems.push(`LFS object ${pointer.oid} is missing`)
  return { at: at.toISOString(), ok: problems.length === 0, packs: names.length, objects, problems, lfsMissing }
}

export const deepCheckMirror = async (storage: Storage, repo: RepositoryName, remote = DEFAULT_REMOTE, now = new Date()): Promise<DeepCheck> => {
  const config = await readMirrorConfig(storage, repo, remote)
  const { lfsMissing, ...check } = await deepCheckRepository(storage, repo, now, config?.lfs ?? false)
  await saveStatus(storage, repo, remote, (status) => ({ ...status, lastDeepCheck: check, lfsPending: deferred(status.lfsPending, lfsMissing) }))
  return check
}

export type UnitOptions = Pick<SyncOptions, 'storage' | 'repo' | 'remote' | 'fetch' | 'getAuthorization' | 'digests'> & {
  readonly maxUnitBytes?: number
}

const unitContext = async (options: UnitOptions) => {
  const remoteName = options.remote ?? DEFAULT_REMOTE
  const config = await readMirrorConfig(options.storage, options.repo, remoteName)
  if (!config) throw new MirrorNotFoundError(`mirror ${remoteName} not configured for ${options.repo.owner}/${options.repo.name}`)
  return { remoteName, config, remote: remoteOf(config, options) }
}

const remotePackSize = async (remote: Remote, name: string): Promise<number | null> => {
  const response = await remoteRequest(remote, remoteUrl(remote.url, `objects/pack/${name}`), { method: 'HEAD' })
  await response.body?.cancel()
  await expectOk(response, `size of ${name}`)
  const declared = response.headers.get('Content-Length')
  const size = Number(declared)
  return declared !== null && Number.isSafeInteger(size) ? size : null
}

export const planPackCopy = async (options: UnitOptions): Promise<readonly PendingPack[] | null> => {
  const { remoteName, config, remote } = await unitContext(options)
  if (config.detachedAt) return []
  const remotePacks = await listRemotePacks(remote)
  if (remotePacks === null) return null
  const local = new Set(await new ObjectDatabase(options.storage, options.repo).packNames())
  const pending: PendingPack[] = []
  for (const name of remotePacks) {
    if (local.has(name)) continue
    const size = await remotePackSize(remote, name)
    pending.push({ name, size, oversized: options.maxUnitBytes !== undefined && size !== null && size > options.maxUnitBytes })
  }
  await saveStatus(options.storage, options.repo, remoteName, (status) => ({ ...status, pendingPacks: pending }))
  return pending
}

export const copyPendingPack = async (options: UnitOptions, name: string): Promise<{ readonly copied: CopiedPack; readonly remaining: number }> => {
  const { remoteName, config, remote } = await unitContext(options)
  const copied = await copyPack({ remote, storage: options.storage, repo: options.repo, name, ...(options.digests ? { digests: options.digests } : {}) })
  await registerPacks(options.storage, options.repo, [name])
  const pointers: LfsPointer[] = []
  if (config.lfs) {
    for (const blob of await new ObjectDatabase(options.storage, options.repo).smallBlobs(name, LFS_POINTER_MAX_SIZE)) {
      const pointer = parseLfsPointer(blob.data)
      if (pointer) pointers.push(pointer)
    }
  }
  let remaining = 0
  await saveStatus(options.storage, options.repo, remoteName, (status) => {
    const pendingPacks = (status.pendingPacks ?? []).filter((pack) => pack.name !== name)
    remaining = pendingPacks.filter((pack) => !pack.oversized).length
    return { ...status, pendingPacks, lfsPending: deferred(status.lfsPending, pointers) }
  })
  return { copied, remaining }
}

export const mirrorPendingLfsObject = async (options: UnitOptions, pointer: LfsPointer): Promise<LfsMirrorResult> => {
  const { remoteName, config, remote } = await unitContext(options)
  const endpoint: LfsEndpoint = (await readMirrorStatus(options.storage, options.repo, remoteName))?.lfsEndpoint ?? {
    url: config.lfsUrl ?? lfsEndpointFor(config.url),
    source: config.lfsUrl ? 'setting' : 'default',
  }
  const result = await mirrorLfsObjects({
    storage: options.storage,
    repo: options.repo,
    remote,
    endpoint: endpoint.url,
    authorize: mayAuthorizeLfs(config.url, endpoint),
    ...(options.digests ? { digests: options.digests } : {}),
    objects: [{ oid: pointer.oid, size: pointer.size }],
  })
  await saveStatus(options.storage, options.repo, remoteName, (status) => ({
    ...status,
    lfsPending: [...status.lfsPending.filter((entry) => entry.oid !== pointer.oid), ...result.missing],
  }))
  return result
}
