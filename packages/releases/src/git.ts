import {
  type DigestFactory,
  isObjectId,
  javascriptDigests,
  lfsObjectSize,
  ObjectDatabase,
  type ObjectId,
  type PushOutcome,
  readRefs,
  type RepositoryName,
  stagingPrefix,
  type Storage,
  storeLfsObject,
  toHex,
  writeRefs,
  writeServerInfo,
} from '@git-forge/core'

const ZERO = '0000000000000000000000000000000000000000'

export const isValidTagName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 255 &&
  !name.startsWith('-') &&
  !name.startsWith('/') &&
  !name.endsWith('/') &&
  !name.endsWith('.') &&
  !name.endsWith('.lock') &&
  !name.includes('..') &&
  !name.includes('//') &&
  !name.includes('@{') &&
  !/[\x00-\x20\x7f~^:?*[\\]/.test(name) &&
  name.split('/').every((part) => !part.startsWith('.'))

export const tagRef = (tag: string): string => `refs/tags/${tag}`

export const tagExists = async (storage: Storage, repo: RepositoryName, tag: string): Promise<boolean> =>
  (await readRefs(storage, repo))?.state.refs[tagRef(tag)] !== undefined

export const defaultBranchOf = async (storage: Storage, repo: RepositoryName): Promise<string> => {
  const refs = await readRefs(storage, repo)
  return (refs?.state.head ?? 'refs/heads/main').replace(/^refs\/heads\//, '')
}

export class TargetError extends Error {}

const resolveTarget = async (odb: ObjectDatabase, refs: Readonly<Record<string, ObjectId>>, target: string): Promise<ObjectId> => {
  const named = refs[`refs/heads/${target}`] ?? refs[target.startsWith('refs/') ? target : '']
  const id = named ?? (isObjectId(target) ? target : null)
  if (!id) throw new TargetError(`target_commitish ${target} is not a branch or commit`)
  const object = await odb.read(id)
  if (object?.type !== 'commit') throw new TargetError(`target_commitish ${target} does not name a commit`)
  return id
}

export const createTag = async (storage: Storage, repo: RepositoryName, tag: string, target: string): Promise<PushOutcome | null> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await readRefs(storage, repo)
    if (!current) throw new TargetError('repository has no Git data')
    if (current.state.refs[tagRef(tag)] !== undefined) return null
    const odb = new ObjectDatabase(storage, repo)
    const id = await resolveTarget(odb, current.state.refs, target)
    const state = { ...current.state, refs: { ...current.state.refs, [tagRef(tag)]: id } }
    if (await writeRefs(storage, repo, state, current.etag)) {
      await writeServerInfo(storage, repo, state, odb)
      return { unpack: 'ok', results: [{ name: tagRef(tag), oldId: ZERO, newId: id, ok: true }], pack: null, objectCount: 0, archived: [] }
    }
  }
  throw new Error('refs changed concurrently, try again')
}

export const assetStagingKey = (repo: RepositoryName): string => `${stagingPrefix(repo)}asset`

export class AssetUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const hashingStream = (digests: DigestFactory, result: { oid?: string; size: number }): TransformStream<Uint8Array, Uint8Array> => {
  const hash = digests('SHA-256')
  return new TransformStream({
    transform(chunk, controller) {
      result.size += chunk.length
      hash.update(chunk)
      controller.enqueue(chunk)
    },
    async flush() {
      result.oid = toHex(await hash.digest())
    },
  })
}

export const storeAsset = async (
  storage: Storage,
  repo: RepositoryName,
  body: ReadableStream<Uint8Array>,
  size: number,
  options: { readonly sha256?: string; readonly digests?: DigestFactory } = {},
): Promise<{ readonly oid: string; readonly size: number; readonly staged: boolean }> => {
  if (options.sha256) {
    const stored = await storeLfsObject(storage, repo, { oid: options.sha256, size }, body)
    if (!stored.ok) throw new AssetUploadError(stored.status, stored.message)
    return { oid: options.sha256, size, staged: false }
  }
  const result: { oid?: string; size: number } = { size: 0 }
  const key = assetStagingKey(repo)
  const staged = await storage.put(key, body.pipeThrough(hashingStream(options.digests ?? javascriptDigests, result)), size, { ifNoneMatch: '*', contentType: 'application/octet-stream' })
  if (!staged.ok || !result.oid || result.size !== size) throw new AssetUploadError(400, 'upload did not match Content-Length')
  const oid = result.oid
  const existing = await lfsObjectSize(storage, repo, oid)
  if (existing === size) return { oid, size, staged: true }
  const copy = await storage.get(key)
  if (!copy) throw new Error(`staged upload ${key} disappeared`)
  const stored = await storeLfsObject(storage, repo, { oid, size }, copy.body)
  if (!stored.ok) throw new AssetUploadError(stored.status, stored.message)
  return { oid, size, staged: true }
}
