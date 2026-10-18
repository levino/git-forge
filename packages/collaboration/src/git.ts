import { advertisedRefs, isObjectId, type ObjectId, ObjectDatabase, parseTag, readRefs, type RefsState } from '@git-forge/core'
import { notFound, type Scope } from './context.ts'

export const objectDatabase = (scope: Pick<Scope, 'storage' | 'repo'>): ObjectDatabase => new ObjectDatabase(scope.storage, scope.repo)

export const currentRefs = async (scope: Pick<Scope, 'storage' | 'repo'>): Promise<RefsState> => {
  const refs = await readRefs(scope.storage, scope.repo)
  if (!refs) throw notFound('Repository has no Git data')
  return refs.state
}

export const BRANCH_PREFIX = 'refs/heads/'

export const branchRef = (branch: string): string => (branch.startsWith(BRANCH_PREFIX) ? branch : `${BRANCH_PREFIX}${branch}`)

export const branchName = (ref: string): string => (ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref)

export const branchTip = (state: RefsState, branch: string): ObjectId | null => advertisedRefs(state).refs[branchRef(branch)] ?? null

export const defaultBranch = (state: RefsState): string => branchName(advertisedRefs(state).head)

export const peelToCommit = async (odb: ObjectDatabase, id: ObjectId): Promise<ObjectId | null> => {
  let current = id
  for (let depth = 0; depth < 10; depth++) {
    const object = await odb.read(current)
    if (!object) return null
    if (object.type === 'commit') return current
    if (object.type !== 'tag') return null
    current = parseTag(object.data).object
  }
  return null
}

export const resolveCommitish = async (scope: Pick<Scope, 'storage' | 'repo'>, ref: string, odb = objectDatabase(scope)): Promise<ObjectId | null> => {
  if (isObjectId(ref)) return peelToCommit(odb, ref)
  const state = advertisedRefs(await currentRefs(scope))
  const id =
    ref === 'HEAD'
      ? state.refs[state.head]
      : ref.startsWith('refs/')
        ? state.refs[ref]
        : (state.refs[`refs/tags/${ref}`] ?? state.refs[`refs/heads/${ref}`])
  return id ? peelToCommit(odb, id) : null
}
