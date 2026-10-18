import { type ObjectId, ZERO_ID } from './hash.ts'
import { ObjectDatabase, readRefs, type RefsState, type RepositoryName, writeRefs, writeServerInfo } from './repository.ts'
import type { Storage } from './storage.ts'

export type RefChange = {
  readonly name: string
  readonly oldId: ObjectId
  readonly newId: ObjectId
}

export type RefUpdateResult =
  | { readonly ok: true; readonly state: RefsState }
  | { readonly ok: false; readonly reason: 'not-found' | 'stale'; readonly ref?: string }

export const updateRefs = async (storage: Storage, repo: RepositoryName, updates: readonly RefChange[], odb = new ObjectDatabase(storage, repo)): Promise<RefUpdateResult> => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await readRefs(storage, repo)
    if (!current) return { ok: false, reason: 'not-found' }
    const refs: Record<string, ObjectId> = { ...current.state.refs }
    for (const update of updates) {
      if ((refs[update.name] ?? ZERO_ID) !== update.oldId) return { ok: false, reason: 'stale', ref: update.name }
      if (update.newId === ZERO_ID) delete refs[update.name]
      else refs[update.name] = update.newId
    }
    const state: RefsState = { ...current.state, refs }
    if (await writeRefs(storage, repo, state, current.etag)) {
      await writeServerInfo(storage, repo, state, odb)
      return { ok: true, state }
    }
  }
  return { ok: false, reason: 'stale' }
}
