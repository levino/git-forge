import { concat, fromUtf8 } from './bytes.ts'
import { isObjectId, type ObjectId, ZERO_ID } from './hash.ts'
import type { GitObject } from './objects.ts'
import { PackError, parsePack, type ResolvedObject, writePack } from './pack.ts'
import { FLUSH, parsePackets, pkt, sideband, SIDEBAND_DATA } from './pktline.ts'
import {
  ObjectDatabase,
  readRefs,
  type RefsState,
  type RepositoryName,
  sortedRefs,
  writeRefs,
  writeServerInfo,
} from './repository.ts'
import type { Storage } from './storage.ts'
import { checkConnectivity, isAncestor, type ObjectSource } from './walk.ts'

export const AGENT = 'git-forge/0.1'

export const RECEIVE_CAPABILITIES = `report-status delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 agent=${AGENT}`

export const ARCHIVE_PREFIX = 'refs/archive/'

export const UPSTREAM_PREFIX = 'refs/upstream/'

export const advertiseReceivePack = (state: RefsState): Uint8Array => {
  const refs = sortedRefs(state)
  const lines =
    refs.length === 0
      ? [pkt(`${ZERO_ID} capabilities^{}\0${RECEIVE_CAPABILITIES}\n`)]
      : refs.map(([name, id], i) => pkt(i === 0 ? `${id} ${name}\0${RECEIVE_CAPABILITIES}\n` : `${id} ${name}\n`))
  return concat([pkt('# service=git-receive-pack\n'), FLUSH, ...lines, FLUSH])
}

export type RefCommand = {
  readonly oldId: ObjectId
  readonly newId: ObjectId
  readonly name: string
}

export type CommandResult = RefCommand & {
  readonly ok: boolean
  readonly reason?: string
  readonly forced?: boolean
}

export type PushOutcome = {
  readonly unpack: string
  readonly results: readonly CommandResult[]
  readonly objects: readonly ResolvedObject[]
  readonly archived: readonly { readonly name: string; readonly id: ObjectId }[]
}

export type RefPolicy = (command: RefCommand & { readonly fastForward: boolean }) => string | null

export type ReceiveOptions = {
  readonly storage: Storage
  readonly repo: RepositoryName
  readonly now?: () => Date
  readonly policy?: RefPolicy
  readonly beforeUpdate?: (objects: readonly ResolvedObject[], commands: readonly RefCommand[]) => Promise<string | null>
}

const parseRequest = (body: Uint8Array): { commands: RefCommand[]; capabilities: Set<string>; pack: Uint8Array } => {
  const { packets, rest } = parsePackets(body, true)
  const commands: RefCommand[] = []
  let capabilities = new Set<string>()
  for (const packet of packets) {
    if (packet.kind !== 'data') continue
    let line = fromUtf8(packet.data).replace(/\n$/, '')
    const nul = line.indexOf('\0')
    if (nul !== -1) {
      capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean))
      line = line.slice(0, nul)
    }
    if (line.startsWith('shallow ')) continue
    const [oldId, newId, name] = line.split(' ')
    if (!oldId || !newId || !name || !isObjectId(oldId) || !isObjectId(newId)) throw new PackError(`invalid command: ${line}`)
    commands.push({ oldId, newId, name })
  }
  return { commands, capabilities, pack: rest }
}

export const validRefName = (name: string): boolean =>
  name.startsWith('refs/') &&
  !name.startsWith(ARCHIVE_PREFIX) &&
  !name.startsWith(UPSTREAM_PREFIX) &&
  !name.endsWith('/') &&
  !name.endsWith('.lock') &&
  !name.endsWith('.') &&
  !name.includes('..') &&
  !name.includes('//') &&
  !name.includes('@{') &&
  !/[\x00-\x20\x7f~^:?*[\\]/.test(name) &&
  !name.split('/').some((part) => part.startsWith('.') || part.length === 0)

export const archiveName = (name: string, at: Date): string =>
  `${ARCHIVE_PREFIX}${at.toISOString().replace(/[:.]/g, '-')}/${name.slice('refs/'.length)}`

const report = (outcome: Pick<PushOutcome, 'unpack' | 'results'>, useSideband: boolean): Uint8Array => {
  const lines = [
    pkt(`unpack ${outcome.unpack}\n`),
    ...outcome.results.map((result) => pkt(result.ok ? `ok ${result.name}\n` : `ng ${result.name} ${result.reason}\n`)),
    FLUSH,
  ]
  const inner = concat(lines)
  return useSideband ? concat([...sideband(SIDEBAND_DATA, inner), FLUSH]) : inner
}

export const receivePack = async (options: ReceiveOptions, body: Uint8Array): Promise<{ response: Uint8Array; outcome: PushOutcome }> => {
  const { storage, repo } = options
  const now = options.now ?? (() => new Date())
  let parsed: ReturnType<typeof parseRequest>
  try {
    parsed = parseRequest(body)
  } catch (error) {
    const outcome = { unpack: `error ${(error as Error).message}`, results: [], objects: [], archived: [] }
    return { response: report(outcome, false), outcome }
  }
  const { commands, capabilities } = parsed
  const useSideband = capabilities.has('side-band-64k')
  const atomic = capabilities.has('atomic')
  const odb = new ObjectDatabase(storage, repo)
  const fail = (unpack: string): { response: Uint8Array; outcome: PushOutcome } => {
    const outcome: PushOutcome = {
      unpack,
      results: commands.map((command) => ({ ...command, ok: false, reason: 'unpacker error' })),
      objects: [],
      archived: [],
    }
    return { response: report(outcome, useSideband), outcome }
  }
  let objects: readonly ResolvedObject[] = []
  let packBytes: Uint8Array | null = null
  let checksum: Uint8Array | null = null
  if (parsed.pack.length > 0) {
    try {
      const pack = await parsePack(parsed.pack, (id) => odb.read(id))
      if (pack.externalBases.length > 0) {
        const rewritten = writePack(pack.objects)
        objects = rewritten.objects
        packBytes = rewritten.bytes
        checksum = rewritten.checksum
      } else {
        objects = pack.objects
        packBytes = parsed.pack
        checksum = pack.checksum
      }
    } catch (error) {
      return fail(`error ${(error as Error).message}`)
    }
  }
  const fresh = new Map<ObjectId, GitObject>(objects.map((object) => [object.id, object]))
  const source: ObjectSource = { read: async (id) => fresh.get(id) ?? (await odb.read(id)) }
  const exists = async (id: ObjectId) => fresh.has(id) || (await odb.has(id))
  const checks = new Map<string, string | null>()
  for (const command of commands) {
    if (!validRefName(command.name)) {
      checks.set(command.name, 'invalid ref name')
      continue
    }
    if (command.newId === ZERO_ID) {
      checks.set(command.name, null)
      continue
    }
    const target = await source.read(command.newId)
    if (!target) {
      checks.set(command.name, 'missing object')
      continue
    }
    if (command.name.startsWith('refs/heads/') && target.type !== 'commit') {
      checks.set(command.name, 'not a commit')
      continue
    }
    const missing = await checkConnectivity(source, command.newId, (id) => fresh.has(id), (id) => odb.has(id))
    checks.set(command.name, missing ? `missing object ${missing}` : null)
  }
  if (options.beforeUpdate) {
    const rejection = await options.beforeUpdate(objects, commands)
    if (rejection) {
      const outcome: PushOutcome = {
        unpack: 'ok',
        results: commands.map((command) => ({ ...command, ok: false, reason: rejection })),
        objects,
        archived: [],
      }
      return { response: report(outcome, useSideband), outcome }
    }
  }
  if (packBytes && checksum && objects.length > 0) await odb.addPack(packBytes, objects, checksum)
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await readRefs(storage, repo)
    if (!current) return fail('error repository not found')
    const at = now()
    const refs: Record<string, ObjectId> = { ...current.state.refs }
    const archived: { name: string; id: ObjectId }[] = []
    const results: CommandResult[] = []
    for (const command of commands) {
      const problem = checks.get(command.name) ?? null
      const existing = current.state.refs[command.name] ?? ZERO_ID
      if (problem) {
        results.push({ ...command, ok: false, reason: problem })
        continue
      }
      if (existing !== command.oldId) {
        results.push({ ...command, ok: false, reason: 'stale info' })
        continue
      }
      const fastForward =
        existing === ZERO_ID || command.newId === ZERO_ID ? existing === ZERO_ID : await isAncestor(source, existing, command.newId)
      const denied = options.policy?.({ ...command, fastForward }) ?? null
      if (denied) {
        results.push({ ...command, ok: false, reason: denied })
        continue
      }
      if (existing !== ZERO_ID && !fastForward) {
        const name = archiveName(command.name, at)
        refs[name] = existing
        archived.push({ name, id: existing })
      }
      if (command.newId === ZERO_ID) delete refs[command.name]
      else refs[command.name] = command.newId
      results.push({ ...command, ok: true, forced: existing !== ZERO_ID && !fastForward })
    }
    const anyFailed = results.some((result) => !result.ok)
    const finalResults =
      atomic && anyFailed
        ? results.map((result) => (result.ok ? { ...result, ok: false, reason: 'atomic push failed' } : result))
        : results
    const outcome: PushOutcome = { unpack: 'ok', results: finalResults, objects, archived: atomic && anyFailed ? [] : archived }
    if (finalResults.every((result) => !result.ok)) return { response: report(outcome, useSideband), outcome }
    const state: RefsState = { ...current.state, refs }
    if (await writeRefs(storage, repo, state, current.etag)) {
      await writeServerInfo(storage, repo, state, odb)
      return { response: report(outcome, useSideband), outcome }
    }
  }
  return fail('error could not update refs')
}

