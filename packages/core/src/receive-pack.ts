import { concat, fromUtf8, SizeLimitError } from './bytes.ts'
import { ByteCursor } from './cursor.ts'
import { isObjectId, type ObjectId, ZERO_ID } from './hash.ts'
import type { LfsObjectSpec } from './lfs.ts'
import { PackError } from './pack.ts'
import type { IndexedPack } from './pack-indexer.ts'
import { FLUSH, pkt, sideband, SIDEBAND_DATA } from './pktline.ts'
import {
  type IngestOptions,
  ObjectDatabase,
  readRefs,
  type RefsState,
  type RepositoryName,
  sortedRefs,
  writeRefs,
  writeServerInfo,
} from './repository.ts'
import type { Storage } from './storage.ts'
import { isAncestor, type ObjectSource } from './walk.ts'

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

export type PushedPack = {
  readonly objectCount: number
  readonly lfsPointers: readonly LfsObjectSpec[]
}

export type PushOutcome = {
  readonly unpack: string
  readonly results: readonly CommandResult[]
  readonly pack: string | null
  readonly objectCount: number
  readonly archived: readonly { readonly name: string; readonly id: ObjectId }[]
  readonly lfsPointers?: readonly LfsObjectSpec[]
}

export type RefPolicy = (command: RefCommand & { readonly fastForward: boolean }) => string | null

export type RefCheck = (command: RefCommand & { readonly fastForward: boolean }) => Promise<string | null>

export type ReceiveOptions = {
  readonly storage: Storage
  readonly repo: RepositoryName
  readonly now?: () => Date
  readonly policy?: RefPolicy
  readonly check?: RefCheck
  readonly beforeUpdate?: (pushed: PushedPack, commands: readonly RefCommand[]) => Promise<string | null>
  readonly pack?: IngestOptions
}

const readCommands = async (cursor: ByteCursor): Promise<{ commands: RefCommand[]; capabilities: Set<string> }> => {
  const commands: RefCommand[] = []
  let capabilities = new Set<string>()
  for (;;) {
    if ((await cursor.fill(4)) < 4) throw new PackError('truncated command list')
    const length = Number.parseInt(fromUtf8(cursor.peek().subarray(0, 4)), 16)
    if (Number.isNaN(length) || (length > 0 && length < 4)) throw new PackError('invalid pkt-line length')
    if (length === 0) {
      cursor.skip(4)
      break
    }
    const packet = await cursor.read(length)
    let line = fromUtf8(packet.subarray(4)).replace(/\n$/, '')
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
  return { commands, capabilities }
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

export const receivePack = async (
  options: ReceiveOptions,
  body: ReadableStream<Uint8Array>,
): Promise<{ response: Uint8Array; outcome: PushOutcome }> => {
  const { storage, repo } = options
  const now = options.now ?? (() => new Date())
  const cursor = new ByteCursor(body)
  let parsed: Awaited<ReturnType<typeof readCommands>>
  try {
    parsed = await readCommands(cursor)
  } catch (error) {
    await cursor.cancel()
    if (error instanceof SizeLimitError) throw error
    const outcome: PushOutcome = { unpack: `error ${(error as Error).message}`, results: [], pack: null, objectCount: 0, archived: [] }
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
      pack: null,
      objectCount: 0,
      archived: [],
    }
    return { response: report(outcome, useSideband), outcome }
  }
  let pack: IndexedPack | null = null
  try {
    if (!(await cursor.atEnd())) pack = await odb.index(cursor, options.pack)
  } catch (error) {
    await cursor.cancel()
    if (error instanceof SizeLimitError) throw error
    return fail(`error ${(error as Error).message}`)
  }
  const objectCount = pack?.objectCount ?? 0
  const source: ObjectSource = { read: async (id) => (await pack?.read(id)) ?? (await odb.read(id)) }
  const typeOf = async (id: ObjectId) => pack?.typeOf(id) ?? (await odb.read(id))?.type ?? null
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
    const type = await typeOf(command.newId)
    if (!type) checks.set(command.name, 'missing object')
    else if (command.name.startsWith('refs/heads/') && type !== 'commit') checks.set(command.name, 'not a commit')
    else checks.set(command.name, null)
  }
  if (options.beforeUpdate) {
    const rejection = await options.beforeUpdate({ objectCount, lfsPointers: pack?.lfsPointers ?? [] }, commands)
    if (rejection) {
      const outcome: PushOutcome = {
        unpack: 'ok',
        results: commands.map((command) => ({ ...command, ok: false, reason: rejection })),
        pack: null,
        objectCount,
        archived: [],
      }
      return { response: report(outcome, useSideband), outcome }
    }
  }
  const packName = pack ? await odb.storePack(pack) : null
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
      const denied = options.policy?.({ ...command, fastForward }) ?? (await options.check?.({ ...command, fastForward })) ?? null
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
    const outcome: PushOutcome = {
      unpack: 'ok',
      results: finalResults,
      pack: packName,
      objectCount,
      archived: atomic && anyFailed ? [] : archived,
      lfsPointers: pack?.lfsPointers ?? [],
    }
    if (finalResults.every((result) => !result.ok)) return { response: report(outcome, useSideband), outcome }
    const state: RefsState = { ...current.state, refs }
    if (await writeRefs(storage, repo, state, current.etag)) {
      await writeServerInfo(storage, repo, state, odb)
      return { response: report(outcome, useSideband), outcome }
    }
  }
  return fail('error could not update refs')
}
