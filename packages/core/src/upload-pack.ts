import { concat, utf8 } from './bytes.ts'
import { isObjectId, type ObjectId } from './hash.ts'
import { parseTag } from './objects.ts'
import { writePack } from './pack.ts'
import { DELIM, FLUSH, packetText, parsePackets, pkt, sideband, SIDEBAND_DATA, SIDEBAND_ERROR, SIDEBAND_PROGRESS } from './pktline.ts'
import { AGENT } from './receive-pack.ts'
import { ObjectDatabase, type RefsState, type RepositoryName, readRefs, sortedRefs } from './repository.ts'
import type { Storage } from './storage.ts'
import { MissingObjectError, reachable } from './walk.ts'

export const advertiseUploadPackV2 = (): Uint8Array =>
  concat([
    pkt('# service=git-upload-pack\n'),
    FLUSH,
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch\n'),
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

const lsRefs = async (state: RefsState, odb: ObjectDatabase, args: readonly string[]): Promise<Uint8Array> => {
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

const fetch = async (state: RefsState, odb: ObjectDatabase, args: readonly string[]): Promise<Uint8Array> => {
  const wants = new Set<ObjectId>()
  const haves: ObjectId[] = []
  let done = false
  const noProgress = args.includes('no-progress')
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.add(arg.slice(5))
    else if (arg.startsWith('have ')) haves.push(arg.slice(5))
    else if (arg === 'done') done = true
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
  let ids: ObjectId[]
  try {
    const excluded = new Set(await reachable(odb, common))
    ids = await reachable(odb, wants, (id) => excluded.has(id))
    if (args.includes('include-tag')) {
      const sent = new Set(ids)
      for (const [, id] of sortedRefs(state)) {
        if (sent.has(id) || excluded.has(id)) continue
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
  const objects = []
  for (const id of ids) {
    const object = await odb.read(id)
    if (!object) throw new MissingObjectError(id)
    objects.push({ ...object, id })
  }
  const pack = writePack(objects)
  sections.push(pkt('packfile\n'))
  if (!noProgress) sections.push(...sideband(SIDEBAND_PROGRESS, utf8(`Sending ${objects.length} objects\n`)))
  sections.push(...sideband(SIDEBAND_DATA, pack.bytes), FLUSH)
  return concat(sections)
}

export const uploadPackV2 = async (storage: Storage, repo: RepositoryName, body: Uint8Array): Promise<Uint8Array> => {
  const refs = await readRefs(storage, repo)
  if (!refs) return errorResponse('repository not found')
  const odb = new ObjectDatabase(storage, repo)
  const request = parseRequest(body)
  switch (request.command) {
    case 'ls-refs':
      return lsRefs(refs.state, odb, request.args)
    case 'fetch':
      return fetch(refs.state, odb, request.args)
    default:
      return errorResponse(`unknown command ${request.command}`)
  }
}
