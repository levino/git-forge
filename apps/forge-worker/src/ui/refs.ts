import { type CommitDetails, type NamedRef, peelToCommitId, readCommit } from '@git-forge/core'
import type { OpenRepository } from './repository.ts'

export const MAX_LISTED_REFS = 200

export const refsWithCommits = async (repo: OpenRepository, refs: readonly NamedRef[]): Promise<{ ref: NamedRef; commit: CommitDetails | null }[]> => {
  const listed = await Promise.all(
    refs.slice(0, MAX_LISTED_REFS).map(async (ref) => {
      const id = await peelToCommitId(repo.odb, ref.id)
      return { ref, commit: id ? await readCommit(repo.odb, id) : null }
    }),
  )
  return listed.sort((a, b) => (b.commit?.committer.timestamp ?? 0) - (a.commit?.committer.timestamp ?? 0))
}
