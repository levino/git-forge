import { type CommandResult, type GitObject, parseCommitMetadata, type PushOutcome, type Signature } from '@git-forge/core'
import { MAX_PUSH_COMMITS, type PushCommit, type PushInfo } from './events.ts'

const ZERO = '0000000000000000000000000000000000000000'

export type ObjectReader = (id: string) => Promise<GitObject | null>

const timestamp = (signature: Signature | null): string => {
  if (!signature) return new Date(0).toISOString()
  const sign = signature.timezone.startsWith('-') ? -1 : 1
  const minutes = sign * (Number(signature.timezone.slice(1, 3)) * 60 + Number(signature.timezone.slice(3, 5)))
  const local = new Date((signature.timestamp + minutes * 60) * 1000).toISOString().slice(0, 19)
  return `${local}${signature.timezone.slice(0, 3)}:${signature.timezone.slice(3)}`
}

const person = (signature: Signature | null) => ({ name: signature?.name ?? '', email: signature?.email ?? '' })

export const pushedCommits = async (
  read: ObjectReader,
  result: Pick<CommandResult, 'oldId' | 'newId'>,
  stopAt: ReadonlySet<string> = new Set(),
  limit = MAX_PUSH_COMMITS,
): Promise<PushCommit[]> => {
  if (result.newId === ZERO) return []
  const found: PushCommit[] = []
  const queue = [result.newId]
  const seen = new Set<string>()
  while (queue.length > 0 && found.length < limit) {
    const id = queue.shift()!
    if (seen.has(id) || id === result.oldId || (stopAt.has(id) && id !== result.newId)) continue
    seen.add(id)
    const object = await read(id)
    if (object?.type !== 'commit') continue
    const commit = parseCommitMetadata(object.data)
    found.push({ id, message: commit.message.replace(/\n$/, ''), timestamp: timestamp(commit.committer ?? commit.author), author: person(commit.author), committer: person(commit.committer) })
    queue.push(...commit.parents)
  }
  return found.reverse()
}

export const pushInfos = async (outcome: PushOutcome, pusher: PushInfo['pusher'], read: ObjectReader, otherTips: ReadonlySet<string> = new Set()): Promise<PushInfo[]> => {
  const infos: PushInfo[] = []
  for (const result of outcome.results) {
    if (!result.ok || !(result.name.startsWith('refs/heads/') || result.name.startsWith('refs/tags/'))) continue
    infos.push({
      ref: result.name,
      before: result.oldId,
      after: result.newId,
      forced: result.forced ?? false,
      commits: result.oldId === ZERO && result.name.startsWith('refs/tags/') ? [] : await pushedCommits(read, result, result.oldId === ZERO ? otherTips : new Set()),
      pusher,
    })
  }
  return infos
}
