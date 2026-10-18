import {
  createRepository,
  type DigestFactory,
  fromUtf8,
  javascriptDigests,
  lfsObjectKey,
  ObjectDatabase,
  packKey,
  readAll,
  readRefs,
  type RefsState,
  type RepositoryName,
  type Storage,
  verifyingPackStream,
  verifyingStream,
  verifyPackIndex,
  writeRefs,
  writeServerInfo,
} from '@git-forge/core'
import { openRun, parseRunKeyRecord, type RecoveryPrivateKey } from './keys.ts'
import { keyRecordKey, objectKey, type Snapshot, type SnapshotRepository, SNAPSHOTS_PREFIX } from './layout.ts'
import { BackupIntegrityError, openStream, type RunKeys } from './seal.ts'

export class BackupNotFoundError extends Error {}

export const runKeys = (backup: Storage, privateKey: RecoveryPrivateKey): RunKeys => {
  const cache = new Map<string, Promise<CryptoKey>>()
  return (run) => {
    let key = cache.get(run)
    if (!key) {
      key = (async () => {
        const stored = await backup.get(keyRecordKey(run))
        if (!stored) throw new BackupNotFoundError(`missing key record for run ${run}`)
        const record = parseRunKeyRecord(await readAll(stored.body))
        if (record.run !== run) throw new BackupIntegrityError(`key record ${run} names run ${record.run}`)
        return openRun(privateKey, record)
      })()
      cache.set(run, key)
    }
    return key
  }
}

export const openObject = async (backup: Storage, keys: RunKeys, name: string): Promise<ReadableStream<Uint8Array>> => {
  const stored = await backup.get(objectKey(name))
  if (!stored) throw new BackupNotFoundError(`missing backup object ${name}`)
  return stored.body.pipeThrough(openStream(keys))
}

export const listSnapshotKeys = async (backup: Storage): Promise<string[]> => {
  const keys: string[] = []
  for await (const info of backup.list(SNAPSHOTS_PREFIX)) keys.push(info.key)
  return keys.sort().reverse()
}

export const readSnapshot = async (backup: Storage, keys: RunKeys, key: string): Promise<Snapshot> => {
  const stored = await backup.get(key)
  if (!stored) throw new BackupNotFoundError(`missing snapshot ${key}`)
  const snapshot = JSON.parse(fromUtf8(await readAll(stored.body.pipeThrough(openStream(keys))))) as Snapshot
  if (snapshot.format !== 'git-forge-backup-snapshot' || snapshot.version !== 1) throw new BackupIntegrityError(`unknown snapshot format in ${key}`)
  return snapshot
}

export type SnapshotSummary = {
  readonly key: string
  readonly run: string
  readonly created: string
  readonly repository: string
  readonly refs: number
  readonly packs: number
  readonly lfs: number
  readonly data: boolean
}

export const summarizeSnapshots = async (backup: Storage, keys: RunKeys): Promise<SnapshotSummary[]> => {
  const summaries: SnapshotSummary[] = []
  for (const key of await listSnapshotKeys(backup)) {
    const { run, created, repository } = await readSnapshot(backup, keys, key)
    summaries.push({
      key,
      run,
      created,
      repository: `${repository.owner}/${repository.name}`,
      refs: Object.keys(repository.refs.refs).length,
      packs: repository.packs.length,
      lfs: repository.lfs.length,
      data: repository.data !== undefined,
    })
  }
  return summaries
}

export const findSnapshot = async (backup: Storage, keys: RunKeys, repository: RepositoryName, key?: string): Promise<{ readonly key: string; readonly snapshot: Snapshot }> => {
  if (key !== undefined) {
    const snapshot = await readSnapshot(backup, keys, key)
    if (snapshot.repository.owner !== repository.owner || snapshot.repository.name !== repository.name) {
      throw new BackupNotFoundError(`snapshot ${key} holds ${snapshot.repository.owner}/${snapshot.repository.name}`)
    }
    return { key, snapshot }
  }
  for (const candidate of await listSnapshotKeys(backup)) {
    const snapshot = await readSnapshot(backup, keys, candidate)
    if (snapshot.repository.owner === repository.owner && snapshot.repository.name === repository.name) return { key: candidate, snapshot }
  }
  throw new BackupNotFoundError(`no snapshot of ${repository.owner}/${repository.name}`)
}

export type RestoreSink = {
  readonly index: (name: string, bytes: Uint8Array) => Promise<void>
  readonly pack: (name: string, size: number, body: ReadableStream<Uint8Array>) => Promise<void>
  readonly lfs: (oid: string, size: number, body: ReadableStream<Uint8Array>) => Promise<void>
  readonly finish: (refs: RefsState, packs: readonly string[]) => Promise<void>
}

export type RestoreResult = {
  readonly packs: number
  readonly lfs: number
  readonly data: Uint8Array | null
}

export const restoreSnapshot = async (
  backup: Storage,
  keys: RunKeys,
  repository: SnapshotRepository,
  sink: RestoreSink,
  digests: DigestFactory = javascriptDigests,
): Promise<RestoreResult> => {
  for (const pack of repository.packs) {
    const index = await readAll(await openObject(backup, keys, pack.index.object))
    if (index.length !== pack.index.size) throw new BackupIntegrityError(`index of ${pack.name} has ${index.length} bytes, expected ${pack.index.size}`)
    const parsed = verifyPackIndex(index, pack.size)
    await sink.index(pack.name.replace(/\.pack$/, '.idx'), index)
    const checksum = index.slice(index.length - 40, index.length - 20)
    const body = (await openObject(backup, keys, pack.object)).pipeThrough(verifyingPackStream({ size: pack.size, objects: parsed.count, checksum }, digests))
    await sink.pack(pack.name, pack.size, body)
  }
  for (const object of repository.lfs) {
    await sink.lfs(object.oid, object.size, (await openObject(backup, keys, object.object)).pipeThrough(verifyingStream(object, digests)))
  }
  let data: Uint8Array | null = null
  if (repository.data) {
    data = await readAll(await openObject(backup, keys, repository.data.object))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)))
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    if (hex !== repository.data.sha256) throw new BackupIntegrityError('the data export does not match its checksum')
  }
  await sink.finish(repository.refs, repository.packs.map((pack) => pack.name))
  return { packs: repository.packs.length, lfs: repository.lfs.length, data }
}

export const storageSink = async (storage: Storage, repository: RepositoryName, refs: RefsState): Promise<RestoreSink> => {
  await createRepository(storage, repository, refs.head.replace(/^refs\/heads\//, ''))
  return {
    index: async (name, bytes) => void (await storage.put(packKey(repository, name), bytes, bytes.length, { contentType: 'application/octet-stream' })),
    pack: async (name, size, body) => void (await storage.put(packKey(repository, name), body, size, { contentType: 'application/octet-stream' })),
    lfs: async (oid, size, body) => void (await storage.put(lfsObjectKey(repository, oid), body, size, { ifNoneMatch: '*', contentType: 'application/octet-stream' })),
    finish: async (state, packs) => {
      const odb = new ObjectDatabase(storage, repository)
      await odb.updatePackList(() => packs)
      const current = await readRefs(storage, repository)
      if (!current || !(await writeRefs(storage, repository, state, current.etag))) throw new Error(`could not write the refs of ${repository.owner}/${repository.name}`)
      await writeServerInfo(storage, repository, state, new ObjectDatabase(storage, repository))
    },
  }
}

export type RestoreRepositoryOptions = {
  readonly backup: Storage
  readonly privateKey: RecoveryPrivateKey
  readonly repository: RepositoryName
  readonly destination: Storage
  readonly as?: RepositoryName
  readonly snapshot?: string
  readonly digests?: DigestFactory
}

export const restoreRepository = async (options: RestoreRepositoryOptions): Promise<RestoreResult & { readonly snapshot: string }> => {
  const keys = runKeys(options.backup, options.privateKey)
  const found = await findSnapshot(options.backup, keys, options.repository, options.snapshot)
  const sink = await storageSink(options.destination, options.as ?? options.repository, found.snapshot.repository.refs)
  const result = await restoreSnapshot(options.backup, keys, found.snapshot.repository, sink, options.digests)
  return { ...result, snapshot: found.key }
}
