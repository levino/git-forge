import {
  type DigestFactory,
  isSubmodule,
  isTreeMode,
  javascriptDigests,
  lfsObjectSize,
  type ObjectDatabase,
  type ObjectId,
  parseCommit,
  parseLfsPointer,
  parseTree,
  readAll,
  readTar,
  type RepositoryName,
  sha256Hex,
  stagingPrefix,
  type Storage,
  storeLfsObject,
  streamOf,
  toHex,
  LFS_POINTER_MAX_SIZE,
} from '@git-forge/core'
import { type Manifest, type ManifestEntry, manifestKey, normalizeSitePath, parseManifest, serializeManifest } from './manifest.ts'

export type BuildLimits = {
  readonly maxFiles: number
  readonly maxBytes: number
  readonly bufferBytes: number
}

export const DEFAULT_BUILD_LIMITS: BuildLimits = { maxFiles: 50_000, maxBytes: 1024 * 1024 * 1024, bufferBytes: 4 * 1024 * 1024 }

export type BuiltSite = {
  readonly manifest: string
  readonly fileCount: number
  readonly totalBytes: number
}

export class DeployError extends Error {}

export type SourcePath = '/' | '/docs'

class SiteBuilder {
  readonly files = new Map<string, ManifestEntry>()
  #bytes = 0

  constructor(readonly limits: BuildLimits) {}

  reserve(size: number): void {
    if (this.files.size >= this.limits.maxFiles) throw new DeployError(`site has more than ${this.limits.maxFiles} files`)
    if (this.#bytes + size > this.limits.maxBytes) throw new DeployError(`site is larger than ${this.limits.maxBytes} bytes`)
    this.#bytes += size
  }

  add(path: string, entry: ManifestEntry): void {
    this.files.set(path, entry)
  }

  get totalBytes(): number {
    return this.#bytes
  }
}

const lfsEntry = (data: Uint8Array): ManifestEntry | null => {
  if (data.length > LFS_POINTER_MAX_SIZE) return null
  const pointer = parseLfsPointer(data)
  return pointer ? { oid: pointer.oid, size: pointer.size, lfs: true } : null
}

const storeBytes = async (storage: Storage, repo: RepositoryName, data: Uint8Array): Promise<ManifestEntry> => {
  const pointer = lfsEntry(data)
  if (pointer) return pointer
  const oid = sha256Hex(data)
  const stored = await storeLfsObject(storage, repo, { oid, size: data.length }, streamOf(data))
  if (!stored.ok) throw new DeployError(stored.message)
  return { oid, size: data.length }
}

const iterableStream = (source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> => {
  const iterator = source[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}

const storeStreamed = async (storage: Storage, repo: RepositoryName, body: AsyncIterable<Uint8Array>, size: number, digests: DigestFactory): Promise<ManifestEntry> => {
  const hash = digests('SHA-256')
  let seen = 0
  const key = `${stagingPrefix(repo)}pages`
  const hashing = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.length
      hash.update(chunk)
      controller.enqueue(chunk)
    },
  })
  const staged = await storage.put(key, iterableStream(body).pipeThrough(hashing), size, { ifNoneMatch: '*', contentType: 'application/octet-stream' })
  if (!staged.ok || seen !== size) throw new DeployError('could not stage a site file')
  const oid = toHex(await hash.digest())
  if ((await lfsObjectSize(storage, repo, oid)) === size) return { oid, size }
  const copy = await storage.get(key)
  if (!copy) throw new Error(`staged file ${key} disappeared`)
  const stored = await storeLfsObject(storage, repo, { oid, size }, copy.body)
  if (!stored.ok) throw new DeployError(stored.message)
  return { oid, size }
}

const finish = async (storage: Storage, repo: RepositoryName, builder: SiteBuilder): Promise<BuiltSite> => {
  if (builder.files.size === 0) throw new DeployError('site has no files')
  const { bytes, oid } = serializeManifest(builder.files)
  await storage.put(manifestKey(repo, oid), bytes, bytes.length, { ifNoneMatch: '*', contentType: 'application/json' })
  return { manifest: oid, fileCount: builder.files.size, totalBytes: builder.totalBytes }
}

export const buildFromTree = async (
  storage: Storage,
  odb: ObjectDatabase,
  repo: RepositoryName,
  commit: ObjectId,
  sourcePath: SourcePath,
  limits: BuildLimits = DEFAULT_BUILD_LIMITS,
): Promise<BuiltSite> => {
  const object = await odb.read(commit)
  if (!object || object.type !== 'commit') throw new DeployError(`commit ${commit} not found`)
  let root = parseCommit(object.data).tree
  if (sourcePath === '/docs') {
    const tree = await odb.read(root)
    const docs = tree?.type === 'tree' ? parseTree(tree.data).find((entry) => entry.name === 'docs' && isTreeMode(entry.mode)) : undefined
    if (!docs) throw new DeployError('source folder /docs does not exist in this commit')
    root = docs.id
  }
  const builder = new SiteBuilder(limits)
  const walk = async (tree: ObjectId, prefix: string): Promise<void> => {
    const data = await odb.read(tree)
    if (!data || data.type !== 'tree') throw new DeployError(`tree ${tree} not found`)
    for (const entry of parseTree(data.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (isTreeMode(entry.mode)) {
        await walk(entry.id, path)
        continue
      }
      if (isSubmodule(entry) || entry.mode === '120000') continue
      const blob = await odb.read(entry.id)
      if (!blob || blob.type !== 'blob') throw new DeployError(`blob ${entry.id} not found`)
      const pointer = lfsEntry(blob.data)
      builder.reserve(pointer ? pointer.size : blob.data.length)
      builder.add(path, pointer ?? (await storeBytes(storage, repo, blob.data)))
    }
  }
  await walk(root, '')
  return finish(storage, repo, builder)
}

export const buildFromTar = async (
  storage: Storage,
  repo: RepositoryName,
  stream: ReadableStream<Uint8Array>,
  limits: BuildLimits = DEFAULT_BUILD_LIMITS,
  digests: DigestFactory = javascriptDigests,
): Promise<BuiltSite> => {
  const builder = new SiteBuilder(limits)
  for await (const entry of readTar(stream)) {
    if (entry.type !== 'file') continue
    const path = normalizeSitePath(entry.path)
    if (path === null) {
      if (entry.path.split('/').includes('..')) throw new DeployError(`invalid path in archive: ${entry.path}`)
      continue
    }
    builder.reserve(entry.size)
    if (entry.size <= limits.bufferBytes) {
      builder.add(path, await storeBytes(storage, repo, await readAll(iterableStream(entry.body))))
    } else {
      builder.add(path, await storeStreamed(storage, repo, entry.body, entry.size, digests))
    }
  }
  return finish(storage, repo, builder)
}

export const readManifest = async (storage: Storage, repo: RepositoryName, oid: string): Promise<Manifest | null> => {
  const object = await storage.get(manifestKey(repo, oid))
  if (!object) return null
  return parseManifest(new TextDecoder().decode(await readAll(object.body)))
}
