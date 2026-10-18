import { type CommandResult, parseCommitMetadata, type PushOutcome, type ResolvedObject, type Signature } from '@git-forge/core'
import { MAX_PUSH_COMMITS, type PushCommit, type PushInfo } from './events.ts'

const ZERO = '0000000000000000000000000000000000000000'

const timestamp = (signature: Signature | null): string => {
  if (!signature) return new Date(0).toISOString()
  const sign = signature.timezone.startsWith('-') ? -1 : 1
  const minutes = sign * (Number(signature.timezone.slice(1, 3)) * 60 + Number(signature.timezone.slice(3, 5)))
  const local = new Date((signature.timestamp + minutes * 60) * 1000).toISOString().slice(0, 19)
  return `${local}${signature.timezone.slice(0, 3)}:${signature.timezone.slice(3)}`
}

const person = (signature: Signature | null) => ({ name: signature?.name ?? '', email: signature?.email ?? '' })

export const pushedCommits = (objects: readonly ResolvedObject[], result: Pick<CommandResult, 'oldId' | 'newId'>, limit = MAX_PUSH_COMMITS): PushCommit[] => {
  if (result.newId === ZERO) return []
  const commits = new Map(objects.filter((object) => object.type === 'commit').map((object) => [object.id, object]))
  const found: PushCommit[] = []
  const queue = [result.newId]
  const seen = new Set<string>()
  while (queue.length > 0 && found.length < limit) {
    const id = queue.shift()!
    if (seen.has(id) || id === result.oldId) continue
    seen.add(id)
    const object = commits.get(id)
    if (!object) continue
    const commit = parseCommitMetadata(object.data)
    found.push({ id, message: commit.message.replace(/\n$/, ''), timestamp: timestamp(commit.committer ?? commit.author), author: person(commit.author), committer: person(commit.committer) })
    queue.push(...commit.parents)
  }
  return found.reverse()
}

export const pushInfos = (outcome: PushOutcome, pusher: PushInfo['pusher']): PushInfo[] =>
  outcome.results
    .filter((result) => result.ok && (result.name.startsWith('refs/heads/') || result.name.startsWith('refs/tags/')))
    .map((result) => ({
      ref: result.name,
      before: result.oldId,
      after: result.newId,
      forced: result.forced ?? false,
      commits: pushedCommits(outcome.objects, result),
      pusher,
    }))
