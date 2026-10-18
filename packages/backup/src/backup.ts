import { lfsPrefix, ObjectDatabase, packKey, readRefs, type RepositoryName, sha256Hex, type Storage, streamOf, utf8 } from '@git-forge/core'
import { type NameKey, opaqueName, type RecoveryPublicKey, sealRun, type SealedRun } from './keys.ts'
import {
  BUCKET_README,
  keyRecordKey,
  OBJECTS_PREFIX,
  objectKey,
  objectNameOf,
  README_KEY,
  runId,
  seenKey,
  type Snapshot,
  type SnapshotData,
  type SnapshotLfsObject,
  type SnapshotPack,
  type SnapshotRepository,
  snapshotKey,
} from './layout.ts'
import { DEFAULT_SEGMENT_SIZE, sealBytes, sealedSize, sealStream } from './seal.ts'

export type RepositoryData = {
  readonly format: string
  readonly bytes: Uint8Array
}

export type BackupTarget = {
  readonly storage: Storage
  readonly recipient: RecoveryPublicKey
  readonly names: NameKey
}

export type BackupOptions = BackupTarget & {
  readonly source: Storage
  readonly repository: RepositoryName
  readonly data?: (repository: RepositoryName) => Promise<RepositoryData | null>
  readonly existing?: Set<string>
  readonly instance?: string
  readonly now?: () => Date
  readonly segment?: number
}

export type BackupResult = {
  readonly repository: RepositoryName
  readonly run: string | null
  readonly snapshot: string | null
  readonly unchanged: boolean
  readonly uploaded: number
  readonly uploadedBytes: number
  readonly present: number
}

export class BackupSourceError extends Error {}

export const listBackupObjects = async (storage: Storage): Promise<Set<string>> => {
  const names = new Set<string>()
  for await (const info of storage.list(OBJECTS_PREFIX)) {
    const name = objectNameOf(info.key)
    if (name) names.add(name)
  }
  return names
}

type Upload = {
  readonly name: string
  readonly size: number
  readonly body: () => Promise<ReadableStream<Uint8Array> | Uint8Array>
}

const sourceBody = (storage: Storage, key: string) => async (): Promise<ReadableStream<Uint8Array>> => {
  const object = await storage.get(key)
  if (!object) throw new BackupSourceError(`${key} disappeared during the backup`)
  return object.body
}

const sizeOf = async (storage: Storage, key: string): Promise<number> => {
  const info = await storage.head(key)
  if (!info) throw new BackupSourceError(`missing ${key}`)
  return info.size
}

const LFS_KEY = /\/objects\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})$/

export const backupRepository = async (options: BackupOptions): Promise<BackupResult> => {
  const { source, repository } = options
  const target = options.storage
  const now = options.now ?? (() => new Date())
  const segment = options.segment ?? DEFAULT_SEGMENT_SIZE
  const refs = await readRefs(source, repository)
  if (!refs) throw new BackupSourceError(`${repository.owner}/${repository.name} does not exist`)
  const uploads: Upload[] = []
  const name = (address: string) => opaqueName(options.names, address)
  const packs: SnapshotPack[] = []
  for (const pack of await new ObjectDatabase(source, repository).packNames()) {
    const index = pack.replace(/\.pack$/, '.idx')
    const packSourceKey = packKey(repository, pack)
    const indexSourceKey = packKey(repository, index)
    const entry: SnapshotPack = {
      name: pack,
      size: await sizeOf(source, packSourceKey),
      object: await name(`git-pack:${pack}`),
      index: { size: await sizeOf(source, indexSourceKey), object: await name(`git-index:${index}`) },
    }
    packs.push(entry)
    uploads.push({ name: entry.object, size: entry.size, body: sourceBody(source, packSourceKey) })
    uploads.push({ name: entry.index.object, size: entry.index.size, body: sourceBody(source, indexSourceKey) })
  }
  const lfs: SnapshotLfsObject[] = []
  for await (const info of source.list(`${lfsPrefix(repository)}objects/`)) {
    const oid = LFS_KEY.exec(info.key)?.[1]
    if (!oid) continue
    const entry = { oid, size: info.size, object: await name(`lfs:${oid}`) }
    lfs.push(entry)
    uploads.push({ name: entry.object, size: entry.size, body: sourceBody(source, info.key) })
  }
  let data: SnapshotData | undefined
  const exported = options.data ? await options.data(repository) : null
  if (exported) {
    const sha256 = sha256Hex(exported.bytes)
    data = { format: exported.format, size: exported.bytes.length, sha256, object: await name(`data:${sha256}`) }
    uploads.push({ name: data.object, size: data.size, body: async () => exported.bytes })
  }
  const snapshotRepository: SnapshotRepository = { owner: repository.owner, name: repository.name, refs: refs.state, packs, lfs, ...(data ? { data } : {}) }
  const existing = options.existing ?? (await listBackupObjects(target))
  let sealed: SealedRun | undefined
  const run = async (): Promise<SealedRun> => {
    if (sealed) return sealed
    const at = now()
    const candidate = await sealRun(options.recipient, runId(at), at)
    const record = utf8(`${JSON.stringify(candidate.record, null, 2)}\n`)
    const written = await target.put(keyRecordKey(candidate.record.run), record, record.length, { ifNoneMatch: '*', contentType: 'application/json' })
    if (!written.ok) throw new Error(`run ${candidate.record.run} exists`)
    if (!(await target.head(README_KEY))) {
      const readme = utf8(BUCKET_README)
      await target.put(README_KEY, readme, readme.length, { ifNoneMatch: '*', contentType: 'text/plain' })
    }
    sealed = candidate
    return candidate
  }
  let uploaded = 0
  let uploadedBytes = 0
  let present = 0
  const done = new Set<string>()
  for (const upload of uploads) {
    if (done.has(upload.name)) continue
    done.add(upload.name)
    if (existing.has(upload.name)) {
      present++
      continue
    }
    const { record, key } = await run()
    const sealedLength = sealedSize(upload.size, record.run, segment)
    const body = await upload.body()
    const stream = body instanceof Uint8Array ? streamOf(body) : body
    const result = await target.put(objectKey(upload.name), stream.pipeThrough(sealStream({ run: record.run, runKey: key, size: upload.size, segment })), sealedLength, {
      ifNoneMatch: '*',
      contentType: 'application/octet-stream',
    })
    existing.add(upload.name)
    if (result.ok) {
      uploaded++
      uploadedBytes += sealedLength
    } else present++
  }
  const tag = await name(`snapshot:${JSON.stringify(snapshotRepository)}`)
  if (await target.head(seenKey(tag))) {
    return { repository, run: sealed?.record.run ?? null, snapshot: null, unchanged: true, uploaded, uploadedBytes, present }
  }
  const { record, key } = await run()
  const snapshot: Snapshot = {
    format: 'git-forge-backup-snapshot',
    version: 1,
    run: record.run,
    created: now().toISOString(),
    ...(options.instance ? { instance: options.instance } : {}),
    repository: snapshotRepository,
  }
  const sealedSnapshot = await sealBytes(utf8(JSON.stringify(snapshot)), { run: record.run, runKey: key, segment })
  const location = snapshotKey(record.run, tag)
  const written = await target.put(location, sealedSnapshot, sealedSnapshot.length, { ifNoneMatch: '*', contentType: 'application/octet-stream' })
  if (!written.ok) throw new Error(`snapshot ${location} exists`)
  await target.put(seenKey(tag), new Uint8Array(0), 0, { ifNoneMatch: '*' })
  return { repository, run: record.run, snapshot: location, unchanged: false, uploaded, uploadedBytes, present }
}

export const backupRepositories = async (
  options: Omit<BackupOptions, 'repository' | 'existing'> & { readonly repositories: readonly RepositoryName[] },
): Promise<BackupResult[]> => {
  const existing = await listBackupObjects(options.storage)
  const results: BackupResult[] = []
  for (const repository of options.repositories) results.push(await backupRepository({ ...options, repository, existing }))
  return results
}
