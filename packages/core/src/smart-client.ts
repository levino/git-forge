import { concat, fromUtf8, readAll, SizeLimitError } from './bytes.ts'
import { isObjectId, type ObjectId } from './hash.ts'
import { parseCommit, parseTag } from './objects.ts'
import { DELIM, FLUSH, pkt, SIDEBAND_DATA, SIDEBAND_ERROR, SIDEBAND_PROGRESS, type Packet } from './pktline.ts'
import { expectOk, type Remote, RemoteError, type RemoteRef, type RemoteRefs, remoteRequest, remoteUrl } from './remote.ts'
import { AGENT } from './receive-pack.ts'
import type { ObjectSource } from './walk.ts'

export type V2Capabilities = ReadonlyMap<string, string>

export class PacketReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  #buffer: Uint8Array = new Uint8Array(0)
  #done = false

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader()
  }

  async #fill(size: number): Promise<boolean> {
    while (this.#buffer.length < size) {
      if (this.#done) return false
      const { done, value } = await this.#reader.read()
      if (done) this.#done = true
      else this.#buffer = this.#buffer.length === 0 ? value : concat([this.#buffer, value])
    }
    return true
  }

  #take(size: number): Uint8Array {
    const out = this.#buffer.subarray(0, size)
    this.#buffer = this.#buffer.subarray(size)
    return out
  }

  async read(): Promise<Packet | null> {
    if (!(await this.#fill(4))) {
      if (this.#buffer.length > 0) throw new RemoteError('truncated pkt-line')
      return null
    }
    const length = Number.parseInt(fromUtf8(this.#take(4)), 16)
    if (Number.isNaN(length) || length === 3) throw new RemoteError('invalid pkt-line length')
    if (length === 0) return { kind: 'flush' }
    if (length === 1) return { kind: 'delim' }
    if (length === 2) return { kind: 'response-end' }
    if (!(await this.#fill(length - 4))) throw new RemoteError('truncated pkt-line')
    return { kind: 'data', data: this.#take(length - 4).slice() }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined)
  }
}

const text = (packet: Packet): string | null => (packet.kind === 'data' ? fromUtf8(packet.data).replace(/\n$/, '') : null)

const checkError = (line: string | null): void => {
  if (line?.startsWith('ERR ')) throw new RemoteError(`remote error: ${line.slice(4)}`)
}

export const parseV2Advertisement = async (stream: ReadableStream<Uint8Array>): Promise<V2Capabilities | null> => {
  const reader = new PacketReader(stream)
  const capabilities = new Map<string, string>()
  let version: string | null = null
  try {
    for (;;) {
      const packet = await reader.read()
      if (!packet) break
      const line = text(packet)
      checkError(line)
      if (line === null) {
        if (packet.kind === 'flush' && version !== null) break
        continue
      }
      if (line.startsWith('# service=')) continue
      if (version === null) {
        if (!line.startsWith('version ')) return null
        version = line.slice('version '.length)
        if (version !== '2') return null
        continue
      }
      const eq = line.indexOf('=')
      capabilities.set(eq === -1 ? line : line.slice(0, eq), eq === -1 ? '' : line.slice(eq + 1))
    }
  } finally {
    await reader.cancel()
  }
  return version === '2' ? capabilities : null
}

const commandRequest = (capabilities: V2Capabilities, command: string, args: readonly string[]): Uint8Array =>
  concat([
    pkt(`command=${command}\n`),
    pkt(`agent=${AGENT}\n`),
    ...(capabilities.has('object-format') ? [pkt('object-format=sha1\n')] : []),
    DELIM,
    ...args.map((arg) => pkt(`${arg}\n`)),
    FLUSH,
  ])

const postCommand = async (remote: Remote, body: Uint8Array): Promise<Response> =>
  expectOk(
    await remoteRequest(remote, remoteUrl(remote.url, 'git-upload-pack'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-git-upload-pack-request',
        Accept: 'application/x-git-upload-pack-result',
        'Git-Protocol': 'version=2',
      },
      body,
    }),
    'git-upload-pack',
  )

export const lsRefsV2 = async (remote: Remote, capabilities: V2Capabilities, prefixes: readonly string[]): Promise<RemoteRefs> => {
  const lsRefs = capabilities.get('ls-refs')
  if (lsRefs === undefined) throw new RemoteError('remote does not support ls-refs')
  const unborn = lsRefs.split(' ').includes('unborn')
  const args = ['peel', 'symrefs', ...(unborn ? ['unborn'] : []), 'ref-prefix HEAD', ...prefixes.map((prefix) => `ref-prefix ${prefix}`)]
  const response = await postCommand(remote, commandRequest(capabilities, 'ls-refs', args))
  if (!response.body) throw new RemoteError('empty ls-refs response')
  const reader = new PacketReader(response.body)
  const refs: RemoteRef[] = []
  let head: string | undefined
  for (;;) {
    const packet = await reader.read()
    if (!packet || packet.kind === 'flush') break
    const line = text(packet)
    checkError(line)
    if (line === null) continue
    const [id, name, ...attributes] = line.split(' ')
    if (!id || !name) throw new RemoteError(`invalid ls-refs line: ${line}`)
    const symref = attributes.find((attribute) => attribute.startsWith('symref-target:'))?.slice('symref-target:'.length)
    const peeled = attributes.find((attribute) => attribute.startsWith('peeled:'))?.slice('peeled:'.length)
    if (name === 'HEAD') {
      if (symref) head = symref
      continue
    }
    if (!isObjectId(id)) throw new RemoteError(`invalid object id in ls-refs: ${id}`)
    refs.push({ name, id, ...(peeled ? { peeled } : {}) })
  }
  await reader.cancel()
  return { ...(head ? { head } : {}), refs }
}

export type FetchResponse = {
  readonly acks: readonly ObjectId[]
  readonly ready: boolean
  readonly pack: Uint8Array | null
  readonly progress: string
}

export type StreamedFetchResponse = {
  readonly acks: readonly ObjectId[]
  readonly ready: boolean
  readonly pack: ReadableStream<Uint8Array> | null
  progress(): string
}

export const openFetchResponse = async (stream: ReadableStream<Uint8Array>, maxPackBytes = Number.POSITIVE_INFINITY): Promise<StreamedFetchResponse> => {
  const reader = new PacketReader(stream)
  const acks: ObjectId[] = []
  let ready = false
  let section: string | null = null
  let progress = ''
  try {
    for (;;) {
      const packet = await reader.read()
      if (!packet) {
        if (section !== null) throw new RemoteError('truncated fetch response')
        break
      }
      if (packet.kind === 'flush' || packet.kind === 'response-end') break
      if (packet.kind === 'delim') {
        section = null
        continue
      }
      if (section === null) {
        const line = text(packet)
        checkError(line)
        section = line
        if (section === 'packfile') break
        continue
      }
      const line = text(packet)
      checkError(line)
      if (section === 'acknowledgments' && line !== null) {
        if (line === 'ready') ready = true
        else if (line.startsWith('ACK ')) acks.push(line.slice(4))
        else if (line !== 'NAK') throw new RemoteError(`unexpected acknowledgment: ${line}`)
      }
    }
  } catch (error) {
    await reader.cancel()
    throw error
  }
  if (section !== 'packfile') {
    await reader.cancel()
    return { acks, ready, pack: null, progress: () => progress }
  }
  let packBytes = 0
  const pack = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const packet = await reader.read()
          if (!packet) throw new RemoteError('truncated fetch response')
          if (packet.kind === 'flush' || packet.kind === 'response-end') {
            await reader.cancel()
            controller.close()
            return
          }
          if (packet.kind !== 'data') throw new RemoteError('unexpected packet in packfile section')
          const channel = packet.data[0]
          const payload = packet.data.subarray(1)
          if (channel === SIDEBAND_DATA) {
            packBytes += payload.length
            if (packBytes > maxPackBytes) throw new SizeLimitError(maxPackBytes)
            controller.enqueue(payload)
            return
          }
          if (channel === SIDEBAND_PROGRESS) progress += fromUtf8(payload)
          else if (channel === SIDEBAND_ERROR) throw new RemoteError(`remote error: ${fromUtf8(payload).trim()}`)
          else throw new RemoteError(`invalid sideband channel ${channel}`)
        }
      } catch (error) {
        await reader.cancel()
        controller.error(error)
      }
    },
    cancel: () => reader.cancel(),
  })
  return { acks, ready, pack, progress: () => progress }
}

export const parseFetchResponse = async (stream: ReadableStream<Uint8Array>, maxPackBytes = Number.POSITIVE_INFINITY): Promise<FetchResponse> => {
  const response = await openFetchResponse(stream, maxPackBytes)
  const pack = response.pack ? await readAll(response.pack) : null
  return { acks: response.acks, ready: response.ready, pack, progress: response.progress() }
}

export type HaveSource = {
  next(count: number, common: ReadonlySet<ObjectId>): Promise<ObjectId[]>
}

export const fixedHaves = (ids: readonly ObjectId[]): HaveSource => {
  let sent = false
  return {
    next: async () => {
      if (sent) return []
      sent = true
      return [...new Set(ids)]
    },
  }
}

export class HaveWalker implements HaveSource {
  readonly #source: ObjectSource
  readonly #queue: ObjectId[]
  readonly #seen = new Set<ObjectId>()
  #last: ObjectId[] = []

  constructor(source: ObjectSource, tips: Iterable<ObjectId>) {
    this.#source = source
    this.#queue = [...new Set(tips)]
  }

  async #commit(id: ObjectId): Promise<ObjectId | null> {
    let current = id
    for (let depth = 0; depth < 10; depth++) {
      const object = await this.#source.read(current)
      if (!object) return null
      if (object.type === 'commit') return current
      if (object.type !== 'tag') return null
      current = parseTag(object.data).object
    }
    return null
  }

  async next(count: number, common: ReadonlySet<ObjectId>): Promise<ObjectId[]> {
    for (const id of this.#last) {
      if (common.has(id)) continue
      const object = await this.#source.read(id)
      if (object?.type === 'commit') this.#queue.push(...parseCommit(object.data).parents)
    }
    const batch: ObjectId[] = []
    while (batch.length < count && this.#queue.length > 0) {
      const tip = this.#queue.shift() as ObjectId
      const id = await this.#commit(tip)
      if (!id || this.#seen.has(id)) continue
      this.#seen.add(id)
      batch.push(id)
    }
    this.#last = batch
    return batch
  }
}

export type FetchPackOptions = {
  readonly wants: readonly ObjectId[]
  readonly haves: HaveSource
  readonly filter?: string
  readonly maxPackBytes?: number
  readonly maxHaves?: number
}

export type FetchedPack = {
  readonly pack: ReadableStream<Uint8Array>
  readonly rounds: number
  readonly common: readonly ObjectId[]
}

export const fetchFeatures = (capabilities: V2Capabilities): ReadonlySet<string> => new Set((capabilities.get('fetch') ?? '').split(' ').filter(Boolean))

export const fetchPackV2 = async (remote: Remote, capabilities: V2Capabilities, options: FetchPackOptions): Promise<FetchedPack> => {
  if (!capabilities.has('fetch')) throw new RemoteError('remote does not support fetch')
  if (options.filter && !fetchFeatures(capabilities).has('filter')) throw new RemoteError('remote does not support filter')
  const maxHaves = options.maxHaves ?? 2048
  const common = new Set<ObjectId>()
  let sent = 0
  let batchSize = 32
  for (let round = 1; ; round++) {
    const batch = await options.haves.next(batchSize, common)
    sent += batch.length
    const done = batch.length === 0 || sent >= maxHaves
    const args = [
      'ofs-delta',
      'no-progress',
      ...(options.filter ? [`filter ${options.filter}`] : []),
      ...options.wants.map((id) => `want ${id}`),
      ...[...common, ...batch].map((id) => `have ${id}`),
      ...(done ? ['done'] : []),
    ]
    const response = await postCommand(remote, commandRequest(capabilities, 'fetch', args))
    if (!response.body) throw new RemoteError('empty fetch response')
    const result = await openFetchResponse(response.body, options.maxPackBytes)
    for (const id of result.acks) common.add(id)
    if (result.pack) return { pack: result.pack, rounds: round, common: [...common] }
    if (done) throw new RemoteError('remote sent no pack after done')
    batchSize = Math.min(batchSize * 2, 256)
  }
}
