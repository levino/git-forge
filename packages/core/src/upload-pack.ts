import { concat, utf8 } from './bytes.ts'
import { isObjectId, type ObjectId } from './hash.ts'
import { parseCommit, parseTag } from './objects.ts'
import { writePack } from './pack.ts'
import { DELIM, FLUSH, packetText, parsePackets, pkt, sideband, SIDEBAND_DATA, SIDEBAND_ERROR, SIDEBAND_PROGRESS } from './pktline.ts'
import { AGENT } from './receive-pack.ts'
import { type AdvertisedRefs, advertisedRefs, ObjectDatabase, type RepositoryName, readRefs, sortedRefs } from './repository.ts'
import type { Storage } from './storage.ts'
import { MissingObjectError, reachable } from './walk.ts'

export const advertiseUploadPackV2 = (): Uint8Array =>
  concat([
    pkt('# service=git-upload-pack\n'),
    FLUSH,
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
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

const shallowWalk = async (odb: ObjectDatabase, wants: Iterable<ObjectId>, depth: number): Promise<{ readonly commits: ObjectId[]; readonly tags: ObjectId[]; readonly boundary: Set<ObjectId> }> => {
  const tags: ObjectId[] = []
  let level: ObjectId[] = []
  for (let id of wants) {
    for (;;) {
      const object = await odb.read(id)
      if (!object) throw new MissingObjectError(id)
      if (object.type !== 'tag') {
        if (object.type === 'commit') level.push(id)
        break
      }
      tags.push(id)
      id = parseTag(object.data).object
    }
  }
  const seen = new Set<ObjectId>()
  const commits: ObjectId[] = []
  const boundary = new Set<ObjectId>()
  for (let current = 1; level.length > 0; current++) {
    const next: ObjectId[] = []
    for (const id of level) {
      if (seen.has(id)) continue
      seen.add(id)
      commits.push(id)
      const object = await odb.read(id)
      if (!object) throw new MissingObjectError(id)
      const { parents } = parseCommit(object.data)
      if (current >= depth) {
        if (parents.length > 0) boundary.add(id)
      } else next.push(...parents)
    }
    level = next
  }
  return { commits, tags, boundary }
}

const relativeWalk = async (
  odb: ObjectDatabase,
  wants: Iterable<ObjectId>,
  clientShallow: ReadonlySet<ObjectId>,
  depth: number,
  excluded: ReadonlySet<ObjectId>,
  behindShallow: ReadonlySet<ObjectId>,
): Promise<{ readonly commits: ObjectId[]; readonly tags: ObjectId[]; readonly boundary: Set<ObjectId> }> => {
  const beyond = await shallowWalk(odb, clientShallow, depth + 1)
  const commits = new Set(beyond.commits)
  const tags: ObjectId[] = []
  for (const id of await reachable(odb, wants, (candidate) => excluded.has(candidate) || behindShallow.has(candidate) || commits.has(candidate))) {
    const object = await odb.read(id)
    if (object?.type === 'commit') commits.add(id)
    else if (object?.type === 'tag') tags.push(id)
  }
  return { commits: [...commits], tags, boundary: beyond.boundary }
}

const fetch = async (state: AdvertisedRefs, odb: ObjectDatabase, args: readonly string[]): Promise<Uint8Array> => {
  const wants = new Set<ObjectId>()
  const haves: ObjectId[] = []
  const clientShallow = new Set<ObjectId>()
  let depth: number | undefined
  let relative = false
  let done = false
  const noProgress = args.includes('no-progress')
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.add(arg.slice(5))
    else if (arg.startsWith('have ')) haves.push(arg.slice(5))
    else if (arg === 'done') done = true
    else if (arg.startsWith('shallow ')) clientShallow.add(arg.slice(8))
    else if (arg.startsWith('deepen ')) {
      depth = Number(arg.slice(7))
      if (!Number.isSafeInteger(depth) || depth < 1) return errorResponse(`invalid depth ${arg.slice(7)}`)
    } else if (arg === 'deepen-relative') relative = true
    else if (arg.startsWith('deepen') || arg.startsWith('filter ')) {
      return errorResponse('only "deepen <depth>" shallow fetches are supported; partial clones are not')
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
    const behindShallow = new Set<ObjectId>()
    for (const id of clientShallow) {
      const object = isObjectId(id) ? await odb.read(id) : null
      if (object?.type === 'commit') for (const parent of parseCommit(object.data).parents) behindShallow.add(parent)
    }
    const excluded = new Set(await reachable(odb, common, (id) => behindShallow.has(id)))
    if (depth !== undefined || clientShallow.size > 0) {
      const walk = depth === undefined ? null : relative ? await relativeWalk(odb, wants, clientShallow, depth, excluded, behindShallow) : await shallowWalk(odb, wants, depth)
      const lines: Uint8Array[] = []
      if (walk) {
        for (const id of walk.boundary) if (!clientShallow.has(id)) lines.push(pkt(`shallow ${id}\n`))
        for (const id of clientShallow) if (walk.commits.includes(id) && !walk.boundary.has(id)) lines.push(pkt(`unshallow ${id}\n`))
      }
      sections.push(pkt('shallow-info\n'), ...lines, DELIM)
      if (walk) {
        const sent = new Set<ObjectId>()
        ids = []
        for (const id of [...walk.tags, ...walk.commits]) {
          if (excluded.has(id) && !clientShallow.has(id)) continue
          if (!excluded.has(id)) {
            sent.add(id)
            ids.push(id)
          }
          const object = await odb.read(id)
          if (object?.type !== 'commit') continue
          for (const treeObject of await reachable(odb, [parseCommit(object.data).tree], (candidate) => sent.has(candidate) || excluded.has(candidate))) {
            sent.add(treeObject)
            ids.push(treeObject)
          }
        }
      } else ids = await reachable(odb, wants, (id) => excluded.has(id) || behindShallow.has(id))
    } else ids = await reachable(odb, wants, (id) => excluded.has(id))
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
      return lsRefs(advertisedRefs(refs.state), odb, request.args)
    case 'fetch':
      return fetch(advertisedRefs(refs.state), odb, request.args)
    default:
      return errorResponse(`unknown command ${request.command}`)
  }
}
