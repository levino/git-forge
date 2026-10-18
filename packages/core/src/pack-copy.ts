import { compareBytes, equalBytes, readAll, readUint32, utf8 } from './bytes.ts'
import { createSha1, sha1 } from './hash.ts'
import { PackIndex } from './pack-index.ts'
import { expectOk, type Remote, RemoteError, remoteRequest, remoteUrl } from './remote.ts'
import { packKey, type RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'

export class PackVerificationError extends Error {}

export const PACK_NAME = /^pack-[0-9a-f]{40}\.pack$/

const HEADER = 8 + 256 * 4
const LARGE = 0x80000000
const PACK_MAGIC = utf8('PACK')

export const verifyPackIndex = (bytes: Uint8Array, packSize: number): PackIndex => {
  let index: PackIndex
  try {
    index = new PackIndex(bytes)
  } catch (error) {
    throw new PackVerificationError((error as Error).message)
  }
  const { count } = index
  const fail = (reason: string): never => {
    throw new PackVerificationError(`invalid pack index: ${reason}`)
  }
  const offsets = HEADER + count * 24
  let large = 0
  for (let i = 0; i < count; i++) if (readUint32(bytes, offsets + i * 4) & LARGE) large++
  if (bytes.length !== HEADER + count * 28 + large * 8 + 40) fail('size does not match object count')
  if (!equalBytes(sha1(bytes.subarray(0, bytes.length - 20)), bytes.subarray(bytes.length - 20))) fail('checksum mismatch')
  let below = 0
  let position = 0
  for (let byte = 0; byte < 256; byte++) {
    const total = readUint32(bytes, 8 + byte * 4)
    if (total < below) fail('fan-out is not monotonic')
    for (; position < total; position++) if (bytes[HEADER + position * 20] !== byte) fail('fan-out does not match object ids')
    below = total
  }
  for (let i = 1; i < count; i++) {
    const previous = bytes.subarray(HEADER + (i - 1) * 20, HEADER + i * 20)
    if (compareBytes(previous, bytes.subarray(HEADER + i * 20, HEADER + (i + 1) * 20)) >= 0) fail('object ids are not strictly sorted')
  }
  const largeTable = offsets + count * 4
  for (let i = 0; i < count; i++) {
    const value = readUint32(bytes, offsets + i * 4)
    const offset =
      value & LARGE
        ? readUint32(bytes, largeTable + (value & 0x7fffffff) * 8) * 2 ** 32 + readUint32(bytes, largeTable + (value & 0x7fffffff) * 8 + 4)
        : value
    if (offset < 12 || offset >= packSize - 20) fail(`offset ${offset} outside the pack`)
  }
  return index
}

export type PackExpectation = {
  readonly size: number
  readonly objects: number
  readonly checksum: Uint8Array
}

export const verifyingPackStream = (expected: PackExpectation): TransformStream<Uint8Array, Uint8Array> => {
  const hash = createSha1()
  const header = new Uint8Array(12)
  let headerFilled = 0
  let seen = 0
  let tail = new Uint8Array(0)
  const fail = (controller: TransformStreamDefaultController<Uint8Array>, reason: string) =>
    controller.error(new PackVerificationError(`invalid pack: ${reason}`))
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.length === 0) return
      seen += chunk.length
      if (seen > expected.size) return fail(controller, `more than ${expected.size} bytes`)
      if (headerFilled < 12) {
        const take = Math.min(12 - headerFilled, chunk.length)
        header.set(chunk.subarray(0, take), headerFilled)
        headerFilled += take
        if (headerFilled === 12) {
          const version = readUint32(header, 4)
          if (!equalBytes(header.subarray(0, 4), PACK_MAGIC) || (version !== 2 && version !== 3)) return fail(controller, 'bad header')
          if (readUint32(header, 8) !== expected.objects) return fail(controller, 'object count differs from its index')
        }
      }
      const combined = tail.length === 0 ? chunk : new Uint8Array(tail.length + chunk.length)
      if (combined !== chunk) {
        combined.set(tail)
        combined.set(chunk, tail.length)
      }
      const keep = Math.min(20, combined.length)
      const ready = combined.subarray(0, combined.length - keep)
      if (ready.length > 0) {
        hash.update(ready)
        controller.enqueue(ready)
      }
      tail = combined.slice(combined.length - keep)
    },
    flush(controller) {
      if (seen !== expected.size) return fail(controller, `expected ${expected.size} bytes, got ${seen}`)
      if (headerFilled < 12 || tail.length !== 20) return fail(controller, 'truncated')
      if (!equalBytes(hash.digest(), tail)) return fail(controller, 'trailer checksum mismatch')
      if (!equalBytes(tail, expected.checksum)) return fail(controller, 'trailer differs from its index')
      controller.enqueue(tail)
    },
  })
}

export const listRemotePacks = async (remote: Remote): Promise<string[]> => {
  const response = await remoteRequest(remote, remoteUrl(remote.url, 'objects/info/packs'))
  if (response.status === 404) {
    await response.body?.cancel()
    return []
  }
  const text = await (await expectOk(response, 'objects/info/packs')).text()
  return text
    .split('\n')
    .filter((line) => line.startsWith('P '))
    .map((line) => line.slice(2).trim())
    .filter((name) => PACK_NAME.test(name))
}

export type CopiedPack = {
  readonly name: string
  readonly bytes: number
  readonly objects: number
  readonly reused: boolean
}

export type CopyPackOptions = {
  readonly remote: Remote
  readonly storage: Storage
  readonly repo: RepositoryName
  readonly name: string
  readonly maxPackBytes?: number
}

export const copyPack = async (options: CopyPackOptions): Promise<CopiedPack> => {
  const { remote, storage, repo, name } = options
  if (!PACK_NAME.test(name)) throw new PackVerificationError(`invalid pack name ${name}`)
  const idxName = name.replace(/\.pack$/, '.idx')
  const limit = options.maxPackBytes ?? Number.POSITIVE_INFINITY
  const [storedPack, storedIdx] = await Promise.all([storage.head(packKey(repo, name)), storage.head(packKey(repo, idxName))])
  if (storedPack && storedIdx) {
    const stored = await storage.get(packKey(repo, idxName))
    const index = verifyPackIndex(stored ? await readAll(stored.body) : new Uint8Array(0), storedPack.size)
    return { name, bytes: storedPack.size, objects: index.count, reused: true }
  }
  const idxResponse = await expectOk(await remoteRequest(remote, remoteUrl(remote.url, `objects/pack/${idxName}`)), `index of ${name}`)
  const idx = idxResponse.body ? await readAll(idxResponse.body, Math.min(limit, 2 ** 31)) : new Uint8Array(0)
  const packResponse = await expectOk(await remoteRequest(remote, remoteUrl(remote.url, `objects/pack/${name}`)), name)
  const declared = packResponse.headers.get('Content-Length')
  const body = packResponse.body
  if (!body) throw new RemoteError(`pack ${name} has no body`)
  let size = declared === null ? Number.NaN : Number(declared)
  let source: ReadableStream<Uint8Array> | Uint8Array = body
  if (!Number.isSafeInteger(size)) {
    source = await readAll(body, limit)
    size = source.length
  }
  if (size > limit) {
    if (source instanceof ReadableStream) await source.cancel()
    throw new RemoteError(`pack ${name} exceeds ${limit} bytes`)
  }
  const index = verifyPackIndex(idx, size)
  const expectation = { size, objects: index.count, checksum: index.packChecksum }
  const verified =
    source instanceof ReadableStream
      ? source.pipeThrough(verifyingPackStream(expectation))
      : await readAll(new Response(source as Uint8Array<ArrayBuffer>).body!.pipeThrough(verifyingPackStream(expectation)))
  await storage.put(packKey(repo, name), verified, size, { contentType: 'application/x-git-packed-objects' })
  await storage.put(packKey(repo, idxName), idx, idx.length, { contentType: 'application/x-git-packed-objects-toc' })
  return { name, bytes: size, objects: index.count, reused: false }
}

