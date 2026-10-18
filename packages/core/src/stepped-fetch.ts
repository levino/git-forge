import { fromUtf8, readAll, SizeLimitError, toHex, utf8 } from './bytes.ts'
import { ByteCursor } from './cursor.ts'
import { connectRemote, type RemoteConnection } from './fetch-client.ts'
import type { ObjectId } from './hash.ts'
import type { LfsObjectSpec } from './lfs.ts'
import type { LfsPointer } from './lfs-mirror.ts'
import { type GitObject, parseCommit, parseTag } from './objects.ts'
import { forEachTreeEntryId, indexPack, ObjectTooLargeError } from './pack-indexer.ts'
import type { Remote } from './remote.ts'
import { type IngestOptions, type ObjectDatabase, type RepositoryName, stagingPrefix } from './repository.ts'
import { fetchPackV2, fixedHaves } from './smart-client.ts'
import type { Storage } from './storage.ts'

export const DEFAULT_COMMITS_PER_STEP = 500

export const MAX_COMMITS_PER_STEP = 20_000

export const MAX_BLOBS_PER_STEP = 10_000

export const DEFAULT_MAX_STEP_BYTES = 32 * 1024 * 1024

export const DEFAULT_MAX_GRAPH_BYTES = 64 * 1024 * 1024

export type FetchSplit = {
  readonly commit: ObjectId
  readonly pack?: string
  readonly blobs: number
  readonly position: number
  readonly blobsPerStep: number
}

export type SteppedProgress = {
  readonly lfs: boolean
  readonly wants: readonly ObjectId[]
  readonly localTips: readonly ObjectId[]
  readonly commitsPerStep: number
  readonly commits: number
  readonly position: number
  readonly cuts: readonly ObjectId[]
  readonly split?: FetchSplit
  readonly fetched: { readonly objects: number; readonly packs: number; readonly bytes: number }
  readonly lfsQueue: readonly LfsPointer[]
}

export type IngestedPack = {
  readonly name: string | null
  readonly objects: number
  readonly bytes: number
  readonly lfsPointers: readonly LfsObjectSpec[]
}

export type IngestPackOptions = IngestOptions & { readonly register?: boolean }

export type PackIngester = (odb: ObjectDatabase, pack: ReadableStream<Uint8Array>, options?: IngestPackOptions) => Promise<IngestedPack>

export const ingestStreamed: PackIngester = async (odb, stream, options = {}) => {
  const { name, pack } = await odb.ingest(stream, options)
  return { name, objects: pack.objectCount, bytes: pack.byteLength, lfsPointers: pack.lfsPointers }
}

export type SteppedFetchLimits = {
  readonly ingestPack?: PackIngester
  readonly maxStepBytes?: number
  readonly maxGraphBytes?: number
  readonly maxObjectBytes?: number
}

export type SteppedFetch = SteppedFetchLimits & {
  readonly storage: Storage
  readonly repo: RepositoryName
  readonly odb: ObjectDatabase
  readonly remote: Remote
  readonly commitsKey: string
  readonly blobsKey: string
}

export const initialProgress = (lfs: boolean, commitsPerStep = DEFAULT_COMMITS_PER_STEP): SteppedProgress => ({
  lfs,
  wants: [],
  localTips: [],
  commitsPerStep: Math.min(Math.max(1, Math.floor(commitsPerStep)), MAX_COMMITS_PER_STEP),
  commits: 0,
  position: 0,
  cuts: [],
  fetched: { objects: 0, packs: 0, bytes: 0 },
  lfsQueue: [],
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

export const mergeLfs = (queue: readonly LfsPointer[], found: readonly LfsPointer[]): LfsPointer[] => {
  const byOid = new Map(queue.map((pointer) => [pointer.oid, pointer]))
  for (const pointer of found) if (!byOid.has(pointer.oid)) byOid.set(pointer.oid, pointer)
  return [...byOid.values()]
}

const v2Capabilities = (connection: RemoteConnection) => {
  if (connection.protocol !== 'v2' || !connection.capabilities) throw new Error('the remote no longer speaks protocol v2')
  return connection.capabilities
}

const readIdList = async (storage: Storage, key: string): Promise<ObjectId[]> => {
  const stored = await storage.get(key)
  if (!stored) throw new Error(`${key} is missing`)
  return fromUtf8(await readAll(stored.body)).split('\n').filter(Boolean)
}

const writeIdList = async (storage: Storage, key: string, ids: readonly ObjectId[]): Promise<void> => {
  const text = utf8(ids.length > 0 ? `${ids.join('\n')}\n` : '')
  await storage.put(key, text, text.length, { contentType: 'text/plain' })
}

const verifyFetched = async (odb: ObjectDatabase, wants: readonly ObjectId[]): Promise<void> => {
  odb.invalidate()
  for (const want of wants) if (!(await odb.has(want))) throw new Error(`the remote did not send object ${want}`)
}

const isOversized = (error: unknown): boolean => error instanceof SizeLimitError || error instanceof ObjectTooLargeError

const ingest = (f: SteppedFetch, pack: ReadableStream<Uint8Array>, extra: IngestPackOptions = {}) =>
  (f.ingestPack ?? ingestStreamed)(f.odb, pack, { ...(f.maxObjectBytes !== undefined ? { maxObjectBytes: f.maxObjectBytes } : {}), ...extra })

const counted = <S extends SteppedProgress>(state: S, stored: IngestedPack): Pick<S, 'fetched' | 'lfsQueue'> => ({
  fetched: {
    objects: state.fetched.objects + stored.objects,
    packs: state.fetched.packs + (stored.name ? 1 : 0),
    bytes: state.fetched.bytes + stored.bytes,
  },
  lfsQueue: state.lfs ? mergeLfs(state.lfsQueue, stored.lfsPointers.map(({ oid, size }) => ({ oid, size }))) : state.lfsQueue,
})

const missingObjects = async (odb: ObjectDatabase, ids: readonly ObjectId[]): Promise<ObjectId[]> => {
  const missing: ObjectId[] = []
  for (const id of ids) if (!(await odb.has(id))) missing.push(id)
  return missing
}

export const fetchCommitGraph = async <S extends SteppedProgress>(f: SteppedFetch, state: S): Promise<S> => {
  const connection = await connectRemote(f.remote, 'v2')
  const fetched = await fetchPackV2(f.remote, v2Capabilities(connection), {
    wants: state.wants,
    haves: fixedHaves(state.localTips),
    filter: 'tree:0',
    maxPackBytes: f.maxGraphBytes ?? DEFAULT_MAX_GRAPH_BYTES,
  })
  const objects = new Map<ObjectId, GitObject>()
  const commits = new Map<ObjectId, readonly ObjectId[]>()
  await indexPack(new ByteCursor(fetched.pack), {
    storage: f.storage,
    stagingPrefix: stagingPrefix(f.repo),
    objects: f.odb,
    checkReferences: false,
    onObject: (id, type, data) => {
      if (type === 'commit') commits.set(id, parseCommit(data).parents)
      else if (type === 'tag') objects.set(id, { type, data })
    },
  })
  for (const id of commits.keys()) objects.set(id, { type: 'commit', data: new Uint8Array(0) })
  const tips = state.wants.map((id) => peel(objects, id)).filter((id): id is ObjectId => id !== null)
  const order = commitOrder(commits, tips)
  await writeIdList(f.storage, f.commitsKey, order)
  return { ...state, commits: order.length, position: 0, cuts: [] }
}

const finishSplit = async <S extends SteppedProgress>(f: SteppedFetch, state: S, split: FetchSplit): Promise<S> => {
  await f.odb.registerPack(split.pack as string)
  await verifyFetched(f.odb, [split.commit])
  const { split: _split, ...rest } = state
  return { ...rest, position: state.position + 1, cuts: [...state.cuts, split.commit] } as unknown as S
}

const listSplit = async <S extends SteppedProgress>(f: SteppedFetch, state: S, split: FetchSplit): Promise<S> => {
  const connection = await connectRemote(f.remote, 'v2')
  const { pack } = await fetchPackV2(f.remote, v2Capabilities(connection), {
    wants: [split.commit],
    haves: fixedHaves([...state.localTips, ...state.cuts]),
    filter: 'blob:none',
  })
  const trees = new Set<ObjectId>()
  const entries = new Set<ObjectId>()
  let sent = false
  const stored = await ingest(f, pack, {
    checkReferences: false,
    register: false,
    onObject: (id, type, data) => {
      if (id === split.commit) sent = true
      if (type !== 'tree') return
      trees.add(id)
      forEachTreeEntryId(data, (bytes, offset) => entries.add(toHex(bytes.subarray(offset, offset + 20))))
    },
  })
  if (!sent || !stored.name) throw new Error(`the remote did not send object ${split.commit}`)
  const blobs = await missingObjects(f.odb, [...entries].filter((id) => !trees.has(id)))
  await writeIdList(f.storage, f.blobsKey, blobs)
  const listed: FetchSplit = {
    commit: split.commit,
    pack: stored.name,
    blobs: blobs.length,
    position: 0,
    blobsPerStep: Math.min(Math.max(1, Math.ceil(blobs.length / 2)), MAX_BLOBS_PER_STEP),
  }
  const next: S = { ...state, ...counted(state, stored), split: listed }
  return blobs.length === 0 ? finishSplit(f, next, listed) : next
}

const fetchSplitBlobs = async <S extends SteppedProgress>(f: SteppedFetch, state: S, split: FetchSplit): Promise<S> => {
  const maxStepBytes = f.maxStepBytes ?? DEFAULT_MAX_STEP_BYTES
  const list = await readIdList(f.storage, f.blobsKey)
  if (list.length !== split.blobs) throw new Error('the blob list does not match the fetch state')
  const batch = list.slice(split.position, split.position + split.blobsPerStep)
  const missing = await missingObjects(f.odb, batch)
  let next: S = state
  let blobsPerStep = split.blobsPerStep
  if (missing.length > 0) {
    const connection = await connectRemote(f.remote, 'v2')
    let stored: IngestedPack
    try {
      const { pack } = await fetchPackV2(f.remote, v2Capabilities(connection), {
        wants: missing,
        haves: fixedHaves([]),
        ...(missing.length > 1 ? { maxPackBytes: maxStepBytes } : {}),
      })
      stored = await ingest(f, pack)
    } catch (error) {
      if (isOversized(error) && missing.length > 1) return { ...state, split: { ...split, blobsPerStep: Math.max(1, Math.floor(missing.length / 2)) } }
      throw error
    }
    await verifyFetched(f.odb, missing)
    next = { ...state, ...counted(state, stored) }
    if (stored.bytes < maxStepBytes / 8) blobsPerStep = Math.min(blobsPerStep * 2, MAX_BLOBS_PER_STEP)
  }
  const progressed: FetchSplit = { ...split, position: split.position + batch.length, blobsPerStep }
  next = { ...next, split: progressed }
  return progressed.position >= progressed.blobs ? finishSplit(f, next, progressed) : next
}

export const fetchNextStep = async <S extends SteppedProgress>(f: SteppedFetch, state: S): Promise<{ readonly state: S; readonly done: boolean }> => {
  if (state.split) return { state: await (state.split.pack ? fetchSplitBlobs(f, state, state.split) : listSplit(f, state, state.split)), done: false }
  const maxStepBytes = f.maxStepBytes ?? DEFAULT_MAX_STEP_BYTES
  const order = await readIdList(f.storage, f.commitsKey)
  const final = state.position >= order.length
  const end = Math.min(state.position + state.commitsPerStep, order.length)
  const wants = final ? state.wants : [order[end - 1] as ObjectId]
  const missing = await missingObjects(f.odb, wants)
  let next: S = state
  let commitsPerStep = state.commitsPerStep
  if (missing.length > 0) {
    const connection = await connectRemote(f.remote, 'v2')
    let stored: IngestedPack
    try {
      const { pack } = await fetchPackV2(f.remote, v2Capabilities(connection), {
        wants: missing,
        haves: fixedHaves([...state.localTips, ...state.cuts]),
        ...(final ? {} : { maxPackBytes: maxStepBytes }),
      })
      stored = await ingest(f, pack)
    } catch (error) {
      if (isOversized(error) && !final) {
        if (state.commitsPerStep > 1) return { state: { ...state, commitsPerStep: Math.max(1, Math.floor(state.commitsPerStep / 4)) }, done: false }
        return { state: { ...state, split: { commit: order[end - 1] as ObjectId, blobs: 0, position: 0, blobsPerStep: 1 } }, done: false }
      }
      throw error
    }
    await verifyFetched(f.odb, missing)
    next = { ...state, ...counted(state, stored) }
    if (stored.bytes < maxStepBytes / 8) commitsPerStep = Math.min(commitsPerStep * 2, MAX_COMMITS_PER_STEP)
  }
  next = { ...next, commitsPerStep }
  if (final) return { state: next, done: true }
  return { state: { ...next, position: end, cuts: [...state.cuts, order[end - 1] as ObjectId] }, done: false }
}
