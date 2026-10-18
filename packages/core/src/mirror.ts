import { equalBytes, fromUtf8, readAll, toHex, utf8 } from './bytes.ts'
import { fetchDumb, lsRefsDumb } from './dumb-client.ts'
import { type ObjectId, sha1 } from './hash.ts'
import { connectRemote, type Protocol, type ProtocolPreference } from './fetch-client.ts'
import { LFS_POINTER_MAX_SIZE, parseLfsPointer } from './lfs.ts'
import { type LfsMissing, type LfsMirrorResult, type LfsPointer, mirrorLfsObjects } from './lfs-mirror.ts'
import { copyPack, listRemotePacks } from './pack-copy.ts'
import { parsePack } from './pack.ts'
import { writeIndex } from './pack-index.ts'
import { isSubmodule, isTreeMode, parseCommit, parseTag, parseTree, references } from './objects.ts'
import { archiveName, UPSTREAM_PREFIX, validRefName } from './receive-pack.ts'
import type { AuthorizationSupplier, FetchFunction, Remote, RemoteRef } from './remote.ts'
import {
  isValidName,
  ObjectDatabase,
  readRefs,
  type RefsState,
  registerPacks,
  type RepositoryName,
  repositoryPrefix,
  writeRefs,
  writeServerInfo,
} from './repository.ts'
import type { Storage } from './storage.ts'
import { isAncestor, MissingObjectError, type ObjectSource } from './walk.ts'

export type MirrorMode = 'auto' | 'manual'

export type MirrorAuth = 'none' | 'instance'

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
  readonly alarms: readonly MirrorAlarm[]
  readonly lastDeepCheck?: DeepCheck
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
  if (!validNamespace(namespace)) throw new Error(`invalid upstream namespace ${namespace}`)
  if (settings.auth !== undefined && settings.auth !== 'none' && settings.auth !== 'instance') throw new Error(`invalid mirror auth ${String(settings.auth)}`)
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

export const detachMirror = (storage: Storage, repo: RepositoryName, remote = DEFAULT_REMOTE, now = new Date()): Promise<MirrorConfig> =>
  updateConfig(storage, repo, remote, (config) => (config.detachedAt ? config : { ...config, detachedAt: now.toISOString() }))

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
  readonly repo: RepositoryName
  readonly remote?: string
  readonly fetch?: FetchFunction
  readonly getAuthorization?: AuthorizationSupplier
  readonly now?: () => Date
  readonly protocol?: ProtocolPreference
  readonly maxPackBytes?: number
}

export type SyncResult = {
  readonly status: 'ok' | 'detached' | 'failed'
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

const saveStatus = async (storage: Storage, repo: RepositoryName, remote: string, change: (status: MirrorStatus) => MirrorStatus) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const stored = await readJson<MirrorStatus>(storage, mirrorStatusKey(repo, remote))
    const base: MirrorStatus = stored?.value ?? { version: 1, remote, lfsPending: [], alarms: [] }
    const result = await writeJson(storage, mirrorStatusKey(repo, remote), change(base), stored ? { ifMatch: stored.etag } : { ifNoneMatch: '*' })
    if (result.ok) return
  }
  throw new Error(`could not save mirror status for ${remote}`)
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
    const remote: Remote = {
      url: config.url,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.getAuthorization ? { getAuthorization: options.getAuthorization } : {}),
    }
    const local = await readRefs(storage, repo)
    if (!local) throw new Error(`repository ${repo.owner}/${repo.name} not found`)
    const odb = new ObjectDatabase(storage, repo)
    const pending = previous?.lfsPending ?? []
    let upstream: UpstreamRefs
    let protocol: Protocol
    let lfsFound: readonly LfsPointer[]
    const remotePacks = options.strategy === 'copy' || options.strategy === 'auto' ? await listRemotePacks(remote) : null
    if (options.strategy === 'copy' || remotePacks !== null) {
      const copied = await copyUpstreamPacks(remote, storage, repo, odb, config, remotePacks ?? [], options.maxPackBytes)
      upstream = copied.upstream
      protocol = 'dumb'
      lfsFound = copied.lfs
      result = { ...result, strategy: 'copy', protocol, fetched: copied.fetched, copied: copied.copied }
    } else {
      const connection = await connectRemote(remote, options.protocol ?? 'auto')
      protocol = connection.protocol
      result = { ...result, strategy: 'fetch', protocol }
      const source = `refs/${config.namespace}`
      const listing = await connection.listRefs([`${source}heads/`, `${source}tags/`])
      upstream = selectUpstreamRefs(listing.refs, config.namespace, listing.head)
      const localTips = [...new Set(Object.values(local.state.refs))]
      const connected = await commitClosure(odb, localTips)
      const newTips = [...new Set(upstream.refs.values())].filter((id) => !connected.has(id))
      if (newTips.length > 0 && !(await isComplete(odb, newTips, connected))) {
        const fetched = await connection.fetchObjects(odb, {
          wants: newTips,
          haveTips: localTips,
          isConnected: (id) => connected.has(id),
          ...(options.maxPackBytes !== undefined ? { maxPackBytes: options.maxPackBytes } : {}),
        })
        result = { ...result, fetched }
      }
      const scan = await scanNewObjects(odb, newTips, connected, config.lfs)
      result = { ...result, scanned: { objects: scan.objects, commits: scan.commits } }
      lfsFound = scan.lfs
    }
    const upstreamChecksum = refsChecksum(upstream.refs)
    result = { ...result, upstreamChecksum, ...(upstream.head ? { upstreamHead: upstream.head } : {}) }
    let lfsPending: readonly LfsMissing[] = pending
    if (config.lfs && (lfsFound.length > 0 || pending.length > 0)) {
      const lfs = await mirrorLfsObjects({
        storage,
        repo,
        remote,
        ...(config.lfsUrl ? { endpoint: config.lfsUrl } : {}),
        objects: [...pending, ...lfsFound].map(({ oid, size }) => ({ oid, size })),
      })
      lfsPending = lfs.missing
      result = { ...result, lfs }
    }
    const plan = await updateUpstreamRefs(storage, repo, odb, remoteName, upstream.refs, now())
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
      lfsPending,
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

const updateUpstreamRefs = async (
  storage: Storage,
  repo: RepositoryName,
  odb: ObjectDatabase,
  remote: string,
  upstream: ReadonlyMap<string, ObjectId>,
  at: Date,
): Promise<RefPlan> => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await readRefs(storage, repo)
    if (!current) throw new Error(`repository ${repo.owner}/${repo.name} not found`)
    const plan = await planRefUpdates(current.state.refs, remote, upstream, at, (oldId, newId) => isAncestor(odb, oldId, newId))
    if (plan.updates.length === 0) {
      await writeServerInfo(storage, repo, current.state, odb)
      return plan
    }
    const state: RefsState = { head: current.state.head, refs: plan.refs }
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
  maxPackBytes: number | undefined,
): Promise<CopyOutcome> => {
  const listing = await lsRefsDumb(remote)
  const upstream = selectUpstreamRefs(listing.refs, config.namespace, listing.head)
  const local = new Set(await odb.packNames())
  const missing = remotePacks.filter((name) => !local.has(name))
  const copied = []
  for (const name of missing) {
    copied.push(await copyPack({ remote, storage, repo, name, ...(maxPackBytes !== undefined ? { maxPackBytes } : {}) }))
  }
  const names = copied.map((pack) => pack.name)
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

export const deepCheckRepository = async (storage: Storage, repo: RepositoryName, at = new Date()): Promise<DeepCheck> => {
  const odb = new ObjectDatabase(storage, repo)
  const problems: string[] = []
  const names = await odb.packNames()
  let objects = 0
  for (const name of names) {
    try {
      const files = await odb.packFiles(name)
      const parsed = await parsePack(files.bytes, (id) => odb.read(id))
      if (!equalBytes(writeIndex(parsed.objects, parsed.checksum), files.index)) problems.push(`${name}: index differs from the recomputed index`)
      objects += parsed.objects.length
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
  return { at: at.toISOString(), ok: problems.length === 0, packs: names.length, objects, problems }
}

export const deepCheckMirror = async (storage: Storage, repo: RepositoryName, remote = DEFAULT_REMOTE, now = new Date()): Promise<DeepCheck> => {
  const check = await deepCheckRepository(storage, repo, now)
  await saveStatus(storage, repo, remote, (status) => ({ ...status, lastDeepCheck: check }))
  return check
}
