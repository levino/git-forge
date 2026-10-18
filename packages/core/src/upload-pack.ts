import { concat, streamOf, utf8 } from './bytes.ts'
import { isObjectId, type ObjectId } from './hash.ts'
import { parseTag } from './objects.ts'
import { streamFrom } from './pack-indexer.ts'
import { emptyPack, generatePack, sidebandFrames, storedPacks, withTrailer } from './pack-writer.ts'
import { DELIM, FLUSH, packetText, parsePackets, pkt, sideband, SIDEBAND_DATA, SIDEBAND_ERROR, SIDEBAND_PROGRESS } from './pktline.ts'
import { AGENT } from './receive-pack.ts'
import { type AdvertisedRefs, advertisedRefs, type LoadedPack, ObjectDatabase, type RepositoryName, readRefs, sortedRefs } from './repository.ts'
import type { Storage } from './storage.ts'
import { MissingObjectError, objectsToSend } from './walk.ts'

export type PackfileUri = (pack: { readonly name: string; readonly key: string }) => Promise<string | null>

export type UploadPackOptions = {
  readonly packfileUri?: PackfileUri
}

export const advertiseUploadPackV2 = (options: UploadPackOptions = {}): Uint8Array =>
  concat([
    pkt('# service=git-upload-pack\n'),
    FLUSH,
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt(options.packfileUri ? 'fetch=packfile-uris\n' : 'fetch\n'),
    pkt('server-option\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ])

type Request = {
  readonly command: string
  readonly args: readonly string[]
}

const parseRequest = (body: Uint8Array): Request => {
  const { packets } = parsePackets(body)
  let command = ''
  const args: string[] = []
  let inArgs = false
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true
      continue
    }
    if (packet.kind === 'flush') break
    const text = packetText(packet)
    if (text === null) continue
    if (!inArgs) {
      if (text.startsWith('command=')) command = text.slice('command='.length)
    } else {
      args.push(text)
    }
  }
  return { command, args }
}

const lsRefs = async (state: AdvertisedRefs, odb: ObjectDatabase, args: readonly string[]): Promise<Uint8Array> => {
  const symrefs = args.includes('symrefs')
  const peel = args.includes('peel')
  const unborn = args.includes('unborn')
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length))
  const wanted = (name: string) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix))
  const lines: Uint8Array[] = []
  if (wanted('HEAD')) {
    const target = state.refs[state.head]
    const suffix = symrefs ? ` symref-target:${state.head}` : ''
    if (target) lines.push(pkt(`${target} HEAD${suffix}\n`))
    else if (unborn) lines.push(pkt(`unborn HEAD${suffix}\n`))
  }
  for (const [name, id] of sortedRefs(state)) {
    if (!wanted(name)) continue
    let line = `${id} ${name}`
    if (peel) {
      const peeled = await odb.peel(id)
      if (peeled !== id) line += ` peeled:${peeled}`
    }
    lines.push(pkt(`${line}\n`))
  }
  return concat([...lines, FLUSH])
}

const errorResponse = (message: string): Uint8Array => concat([pkt(`ERR ${message}\n`), FLUSH])

const uriSection = async (packs: readonly LoadedPack[], protocols: readonly string[], packfileUri: PackfileUri): Promise<Uint8Array[] | null> => {
  const lines: Uint8Array[] = []
  for (const pack of packs) {
    const uri = await packfileUri({ name: pack.name, key: pack.key })
    if (!uri || !protocols.includes(new URL(uri).protocol.replace(/:$/, ''))) return null
    lines.push(pkt(`${pack.name.slice('pack-'.length, -'.pack'.length)} ${uri}\n`))
  }
  return [pkt('packfile-uris\n'), ...lines, DELIM]
}

const fetch = async (state: AdvertisedRefs, odb: ObjectDatabase, args: readonly string[], options: UploadPackOptions): Promise<AsyncIterable<Uint8Array> | Uint8Array> => {
  const wants = new Set<ObjectId>()
  const haves: ObjectId[] = []
  let done = false
  let uriProtocols: string[] = []
  const noProgress = args.includes('no-progress')
  const thinPack = args.includes('thin-pack')
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.add(arg.slice(5))
    else if (arg.startsWith('have ')) haves.push(arg.slice(5))
    else if (arg === 'done') done = true
    else if (arg.startsWith('packfile-uris ')) uriProtocols = arg.slice('packfile-uris '.length).split(',')
    else if (arg.startsWith('deepen') || arg.startsWith('shallow ') || arg.startsWith('filter ')) {
      return errorResponse('shallow and partial clones are not supported')
    }
  }
  for (const id of wants) {
    if (!isObjectId(id) || !(await odb.has(id))) return errorResponse(`not our ref ${id}`)
  }
  const common: ObjectId[] = []
  for (const id of haves) if (isObjectId(id) && (await odb.has(id))) common.push(id)
  const sections: Uint8Array[] = []
  if (!done) {
    sections.push(pkt('acknowledgments\n'))
    if (common.length === 0) sections.push(pkt('NAK\n'))
    for (const id of common) sections.push(pkt(`ACK ${id}\n`))
    sections.push(pkt('ready\n'), DELIM)
  }
  let pack: AsyncIterable<Uint8Array>
  let progress: string
  if (common.length === 0) {
    const packs = await odb.packs()
    const uris = options.packfileUri && uriProtocols.length > 0 ? await uriSection(packs, uriProtocols, options.packfileUri) : null
    if (uris) {
      sections.push(...uris)
      pack = (async function* () {
        yield emptyPack()
      })()
      progress = `Sending ${packs.length} pack URIs\n`
    } else {
      pack = storedPacks(odb, packs)
      progress = `Sending ${packs.length} stored packs\n`
    }
  } else {
    let ids: ObjectId[]
    let clientHas: ReadonlySet<ObjectId>
    try {
      const plan = await objectsToSend(odb, wants, common)
      ids = [...plan.ids]
      clientHas = plan.clientHas
      if (args.includes('include-tag')) {
        const sent = new Set(ids)
        for (const [, id] of sortedRefs(state)) {
          if (sent.has(id) || clientHas.has(id)) continue
          const object = await odb.read(id)
          if (object?.type === 'tag' && sent.has(parseTag(object.data).object)) {
            ids.push(id)
            sent.add(id)
          }
        }
      }
    } catch (error) {
      if (error instanceof MissingObjectError) return concat([...sections, pkt('packfile\n'), ...sideband(SIDEBAND_ERROR, utf8(`${error.message}\n`)), FLUSH])
      throw error
    }
    const sending = new Set(ids)
    pack = withTrailer(generatePack(odb, ids, { sending, ...(thinPack ? { clientHas } : {}) }))
    progress = `Sending ${ids.length} objects\n`
  }
  return (async function* () {
    yield concat([...sections, pkt('packfile\n'), ...(noProgress ? [] : sideband(SIDEBAND_PROGRESS, utf8(progress)))])
    try {
      yield* sidebandFrames(SIDEBAND_DATA, pack)
    } catch (error) {
      yield concat(sideband(SIDEBAND_ERROR, utf8(`${(error as Error).message}\n`)))
    }
    yield FLUSH
  })()
}

export const uploadPackV2 = async (
  storage: Storage,
  repo: RepositoryName,
  body: Uint8Array,
  options: UploadPackOptions = {},
): Promise<ReadableStream<Uint8Array>> => {
  const refs = await readRefs(storage, repo)
  if (!refs) return streamOf(errorResponse('repository not found'))
  const odb = new ObjectDatabase(storage, repo)
  const request = parseRequest(body)
  switch (request.command) {
    case 'ls-refs':
      return streamOf(await lsRefs(advertisedRefs(refs.state), odb, request.args))
    case 'fetch': {
      const result = await fetch(advertisedRefs(refs.state), odb, request.args, options)
      return result instanceof Uint8Array ? streamOf(result) : streamFrom(result)
    }
    default:
      return streamOf(errorResponse(`unknown command ${request.command}`))
  }
}
