import { fromUtf8, readAll, toHex } from './bytes.ts'
import { hashObject, type ObjectId } from './hash.ts'
import { type GitObject, type ObjectType, references } from './objects.ts'
import { parsePack, writePack } from './pack.ts'
import { PackIndex } from './pack-index.ts'
import { expectOk, parseInfoRefs, type Remote, RemoteError, type RemoteRefs, remoteRequest, remoteUrl } from './remote.ts'
import type { ObjectDatabase } from './repository.ts'
import { inflateAt } from './zlib.ts'

const getText = async (remote: Remote, path: string, what: string): Promise<string | null> => {
  const response = await remoteRequest(remote, remoteUrl(remote.url, path))
  if (response.status === 404) return null
  return (await expectOk(response, what)).text()
}

const getBytes = async (remote: Remote, path: string, what: string, limit: number): Promise<Uint8Array | null> => {
  const response = await remoteRequest(remote, remoteUrl(remote.url, path))
  if (response.status === 404) {
    await response.body?.cancel()
    return null
  }
  await expectOk(response, what)
  return response.body ? readAll(response.body, limit) : new Uint8Array(0)
}

export const parseHeadFile = (text: string): string | undefined => {
  const match = /^ref: (refs\/\S+)\s*$/.exec(text)
  return match?.[1]
}

export const lsRefsDumb = async (remote: Remote, infoRefs?: string): Promise<RemoteRefs> => {
  const text = infoRefs ?? (await getText(remote, 'info/refs', 'info/refs'))
  if (text === null) throw new RemoteError('info/refs not found', 404)
  const head = parseHeadFile((await getText(remote, 'HEAD', 'HEAD')) ?? '')
  return { ...(head ? { head } : {}), refs: parseInfoRefs(text) }
}

const LOOSE_TYPES = new Set<string>(['commit', 'tree', 'blob', 'tag'])

export const parseLooseObject = (compressed: Uint8Array, id: ObjectId): GitObject => {
  const raw = inflateAt(compressed, 0).data
  const nul = raw.indexOf(0)
  const header = nul === -1 ? '' : fromUtf8(raw.subarray(0, nul))
  const [type, size] = header.split(' ')
  if (!type || !LOOSE_TYPES.has(type) || Number(size) !== raw.length - nul - 1) throw new RemoteError(`invalid loose object ${id}`)
  const object = { type: type as ObjectType, data: raw.subarray(nul + 1).slice() }
  if (hashObject(object.type, object.data) !== id) throw new RemoteError(`loose object ${id} has wrong hash`)
  return object
}

export type DumbFetchOptions = {
  readonly wants: readonly ObjectId[]
  readonly isConnected: (id: ObjectId) => boolean
  readonly maxPackBytes?: number
}

export type DumbFetchResult = {
  readonly packs: readonly string[]
  readonly looseObjects: number
  readonly objects: number
}

type RemotePack = { readonly name: string; readonly index: PackIndex }

export const fetchDumb = async (remote: Remote, odb: ObjectDatabase, options: DumbFetchOptions): Promise<DumbFetchResult> => {
  const limit = options.maxPackBytes ?? Number.POSITIVE_INFINITY
  const loose = new Map<ObjectId, GitObject>()
  const added: string[] = []
  let objectCount = 0
  let remotePacks: RemotePack[] | null = null

  const loadRemotePacks = async (): Promise<RemotePack[]> => {
    if (remotePacks) return remotePacks
    const local = new Set(await odb.packNames())
    const listing = (await getText(remote, 'objects/info/packs', 'objects/info/packs')) ?? ''
    const names = listing
      .split('\n')
      .filter((line) => line.startsWith('P '))
      .map((line) => line.slice(2).trim())
      .filter((name) => /^pack-[0-9a-f]{40}\.pack$/.test(name) && !local.has(name))
    remotePacks = []
    for (const name of names) {
      const bytes = await getBytes(remote, `objects/pack/${name.replace(/\.pack$/, '.idx')}`, `index of ${name}`, limit)
      if (bytes) remotePacks.push({ name, index: new PackIndex(bytes) })
    }
    return remotePacks
  }

  const downloadPackContaining = async (id: ObjectId): Promise<boolean> => {
    const packs = await loadRemotePacks()
    const position = packs.findIndex((pack) => pack.index.find(id) !== null)
    if (position === -1) return false
    const [pack] = packs.splice(position, 1) as [RemotePack]
    const bytes = await getBytes(remote, `objects/pack/${pack.name}`, pack.name, limit)
    if (!bytes) throw new RemoteError(`pack ${pack.name} listed but not found`, 404)
    const parsed = await parsePack(bytes, (base) => odb.read(base))
    if (toHex(parsed.checksum) !== toHex(pack.index.packChecksum)) throw new RemoteError(`pack ${pack.name} does not match its index`)
    if (parsed.externalBases.length > 0) {
      const rewritten = writePack(parsed.objects)
      added.push(await odb.addPack(rewritten.bytes, rewritten.objects, rewritten.checksum))
    } else {
      added.push(await odb.addPack(bytes, parsed.objects, parsed.checksum))
    }
    objectCount += parsed.objects.length
    return true
  }

  const fetchLoose = async (id: ObjectId): Promise<GitObject | null> => {
    const bytes = await getBytes(remote, `objects/${id.slice(0, 2)}/${id.slice(2)}`, `object ${id}`, limit)
    if (!bytes) return null
    const object = parseLooseObject(bytes, id)
    loose.set(id, object)
    return object
  }

  const read = async (id: ObjectId): Promise<GitObject | null> => {
    const cached = loose.get(id)
    if (cached) return cached
    const local = await odb.read(id)
    if (local) return local
    if (await downloadPackContaining(id)) return odb.read(id)
    return fetchLoose(id)
  }

  const seen = new Set<ObjectId>()
  const stack = [...options.wants]
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId
    if (seen.has(id)) continue
    seen.add(id)
    if (options.isConnected(id)) continue
    const object = await read(id)
    if (!object) throw new RemoteError(`object ${id} not found on dumb remote`, 404)
    stack.push(...references(object))
  }
  if (loose.size > 0) {
    const written = writePack([...loose].map(([id, object]) => ({ ...object, id })))
    added.push(await odb.addPack(written.bytes, written.objects, written.checksum))
    objectCount += loose.size
  }
  return { packs: added, looseObjects: loose.size, objects: objectCount }
}
