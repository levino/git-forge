import type { ObjectId } from './hash.ts'
import { streamFrom } from './pack-indexer.ts'
import { generatePack, withTrailer } from './pack-writer.ts'
import {
  advertisedRefs,
  alternateRepositories,
  createRepository,
  ObjectDatabase,
  readRefs,
  type RefsState,
  type RepositoryName,
  writeAlternates,
  writeRefs,
  writeServerInfo,
} from './repository.ts'
import type { Storage } from './storage.ts'
import { objectsToSend } from './walk.ts'

export type ForkOptions = {
  readonly defaultBranchOnly?: boolean
}

export const forkRefs = (upstream: RefsState, options: ForkOptions = {}): RefsState => {
  const view = advertisedRefs(upstream)
  const refs: Record<string, ObjectId> = {}
  for (const [name, id] of Object.entries(view.refs)) {
    if (options.defaultBranchOnly ? name === view.head : name.startsWith('refs/heads/') || name.startsWith('refs/tags/')) refs[name] = id
  }
  return { head: view.head, refs }
}

export const forkRepository = async (storage: Storage, upstream: RepositoryName, fork: RepositoryName, options: ForkOptions = {}): Promise<RefsState> => {
  const source = await readRefs(storage, upstream)
  if (!source) throw new Error(`${upstream.owner}/${upstream.name} has no Git data`)
  const state = forkRefs(source.state, options)
  await createRepository(storage, fork, state.head.replace(/^refs\/heads\//, ''))
  await writeAlternates(storage, fork, [upstream])
  const created = await readRefs(storage, fork)
  if (!created || !(await writeRefs(storage, fork, state, created.etag))) throw new Error(`could not write the refs of ${fork.owner}/${fork.name}`)
  await writeServerInfo(storage, fork, state, new ObjectDatabase(storage, fork))
  return state
}

export const sharesObjectsWith = async (storage: Storage, repo: RepositoryName, other: RepositoryName): Promise<boolean> =>
  (await alternateRepositories(storage, repo)).some((candidate) => candidate.owner === other.owner && candidate.name === other.name)

export type TransferResult = { readonly objects: number; readonly pack: string | null }

export const transferObjects = async (from: ObjectDatabase, to: ObjectDatabase, wants: readonly ObjectId[], haves: readonly ObjectId[]): Promise<TransferResult> => {
  const missingWants: ObjectId[] = []
  for (const id of wants) if (!(await to.has(id))) missingWants.push(id)
  if (missingWants.length === 0) return { objects: 0, pack: null }
  const usableHaves: ObjectId[] = []
  for (const id of haves) if (await from.has(id)) usableHaves.push(id)
  const plan = await objectsToSend(from, missingWants, usableHaves)
  const ids: ObjectId[] = []
  for (const id of plan.ids) if (!(await to.has(id))) ids.push(id)
  if (ids.length === 0) return { objects: 0, pack: null }
  const { name } = await to.ingest(streamFrom(withTrailer(generatePack(from, ids, { sending: new Set(ids) }))))
  return { objects: ids.length, pack: name }
}
