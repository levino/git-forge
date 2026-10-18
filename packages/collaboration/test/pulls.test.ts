import { spawnSync } from 'node:child_process'
import { DEFAULT_PROTECTION } from '@git-forge/accounts'
import { readRefs } from '@git-forge/core'
import { commitAll, git, gitEnv, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { describe, expect, it } from 'vitest'
import {
  CollaborationError,
  createIssue,
  createPull,
  createReview,
  createReviewComment,
  createStatus,
  dismissReview,
  getIssue,
  getPull,
  handlePushedRefs,
  listEvents,
  listReviewComments,
  listReviews,
  mergePull,
  pullCodeOwners,
  pullCommits,
  pullDiff,
  pullFiles,
  submitReview,
  updatePull,
  updateSettings,
} from '../src/index.ts'
import { createFixture, type Fixture, lines } from './fixture.ts'

const caught = async (promise: Promise<unknown>): Promise<CollaborationError> => {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  )
  if (!(error instanceof CollaborationError)) throw new Error(`expected a CollaborationError, got ${String(error)}`)
  return error
}

const signatureEnv = (fixture: Fixture, login: string) => {
  const name = login[0]!.toUpperCase() + login.slice(1)
  const date = `@${fixture.clock.now / 1000} +0000`
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${login}@example.org`, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${login}@example.org`, GIT_COMMITTER_DATE: date }
}

const gitAs = (fixture: Fixture, login: string, args: readonly string[]) => {
  const result = spawnSync('git', args, { cwd: fixture.dir, env: { ...process.env, ...gitEnv, ...signatureEnv(fixture, login) }, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

const tip = async (fixture: Fixture, branch: string) => (await readRefs(fixture.storage, { owner: 'alice', name: 'site' }))!.state.refs[`refs/heads/${branch}`]

describe('pull requests', () => {
  it('computes files, diff and commits like git', async () => {
    const fixture = await createFixture()
    const carol = await fixture.scope('carol')
    const pull = await createPull(carol, { title: 'Add docs', body: 'Please review', head: 'alice:feature', base: 'main' })
    expect(pull).toMatchObject({ number: 1, headRef: 'feature', baseRef: 'main', headSha: fixture.rev('feature'), mergeable: true, rebaseable: true, mergeableState: 'clean', commits: 1, additions: 2, deletions: 1, changedFiles: 2 })
    expect(pull.mergeBase).toBe(fixture.rev('main~1'))
    expect((await pullFiles(carol, 1)).map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ['README.md', 'modified', 1, 1],
      ['docs/new.md', 'added', 1, 0],
    ])
    expect(await pullDiff(carol, 1)).toBe(git(fixture.dir, ['diff', '--no-indent-heuristic', 'main...feature']))
    expect((await pullCommits(carol, 1)).map((commit) => [commit.sha, commit.message])).toEqual([[fixture.rev('feature'), 'feature: docs\n\nFixes #1\n']])
    expect((await caught(createPull(carol, { title: 'again', head: 'feature', base: 'main' }))).message).toMatch(/already exists/)
    git(fixture.dir, ['branch', 'old', 'main~1'])
    await fixture.sync(['old'])
    expect((await caught(createPull(carol, { title: 'empty', head: 'old', base: 'main' }))).message).toMatch(/No commits/)
    expect((await caught(createPull(carol, { title: 'missing', head: 'nope', base: 'main' }))).status).toBe(422)
    expect((await caught(createPull(carol, { title: 'fork', head: 'mallory:feature', base: 'main' }))).details).toEqual([{ resource: 'PullRequest', field: 'head', code: 'invalid' }])
  })

  it('merges like git merge --no-ff and closes linked issues on the default branch', async () => {
    const fixture = await createFixture()
    const bob = await fixture.scope('bob')
    await createIssue(bob, { title: 'Docs are missing' })
    await createPull(bob, { title: 'Add docs', head: 'feature', base: 'main' })
    expect((await caught(mergePull(await fixture.scope('dave'), 2))).status).toBe(403)
    expect((await caught(mergePull(bob, 2, { sha: fixture.rev('main') }))).status).toBe(409)
    const result = await mergePull(bob, 2, { sha: fixture.rev('feature') })
    gitAs(fixture, 'bob', ['merge', '--no-ff', '-q', '-m', 'Merge pull request #2 from alice/feature', '-m', 'Add docs', 'feature'])
    expect(result).toMatchObject({ sha: fixture.rev('main'), merged: true, closedIssues: [1] })
    expect(await tip(fixture, 'main')).toBe(result.sha)
    expect(await getPull(bob, 2)).toMatchObject({ state: 'closed', merged: true, mergeMethod: 'merge', mergeCommitSha: result.sha, mergedBy: { login: 'bob' }, mergeable: null })
    expect(await getIssue(bob, 1)).toMatchObject({ state: 'closed', stateReason: 'completed', closedBy: { login: 'bob' } })
    expect((await listEvents(bob, 2)).map((event) => event.event)).toEqual(['merged', 'closed'])
    expect((await caught(mergePull(bob, 2))).message).toMatch(/already merged/)
    expect((await caught(updatePull(bob, 2, { state: 'open' }))).message).toMatch(/merged/)
    expect(await pullDiff(bob, 2)).toBe(git(fixture.dir, ['diff', '--no-indent-heuristic', 'main~1...feature']))
  })

  it('squashes and rebases like git', async () => {
    const squash = await createFixture()
    const bob = await squash.scope('bob')
    await createPull(bob, { title: 'Add docs', head: 'feature', base: 'main' })
    const squashed = await mergePull(bob, 1, { method: 'squash' })
    gitAs(squash, 'bob', ['merge', '--squash', '-q', 'feature'])
    gitAs(squash, 'bob', ['commit', '-q', '-m', 'Add docs (#1)', '-m', 'Fixes #1'])
    expect(git(squash.dir, ['rev-parse', 'HEAD^{tree}']).trim()).toBe(git(squash.dir, ['rev-parse', `${squashed.sha}^{tree}`]).trim())
    expect(squashed.sha).toBe(squash.rev('HEAD'))

    const rebase = await createFixture()
    const bob2 = await rebase.scope('bob')
    await createPull(bob2, { title: 'Add docs', head: 'feature', base: 'main' })
    const rebased = await mergePull(bob2, 1, { method: 'rebase' })
    git(rebase.dir, ['checkout', '-q', 'feature'])
    gitAs(rebase, 'bob', ['rebase', '-q', '--force-rebase', 'main'])
    expect(rebased.sha).toBe(rebase.rev('HEAD'))

    await updateSettings(await squash.scope('alice'), { allowRebaseMerge: false })
    git(squash.dir, ['checkout', '-q', '-b', 'more', 'main'])
    writeFile(squash.dir, 'more.txt', 'more\n')
    commitAll(squash.dir, 'more')
    await squash.sync(['more'])
    await createPull(await squash.scope('bob'), { title: 'More', head: 'more', base: 'main' })
    expect((await caught(mergePull(await squash.scope('bob'), 2, { method: 'rebase' }))).status).toBe(405)
  })

  it('detects conflicts without writing anything', async () => {
    const fixture = await createFixture()
    const bob = await fixture.scope('bob')
    const pull = await createPull(bob, { title: 'Conflict', head: 'conflict', base: 'main' })
    expect(pull).toMatchObject({ mergeable: false, rebaseable: false, mergeableState: 'dirty', conflicts: [{ path: 'src/app.ts', reason: 'content' }] })
    const error = await caught(mergePull(bob, 1))
    expect(error.status).toBe(405)
    expect(error.details).toEqual([{ path: 'src/app.ts', reason: 'content' }])
    expect(await tip(fixture, 'main')).toBe(fixture.rev('main'))
  })

  it('enforces required reviews and status checks and dismisses stale approvals', async () => {
    const fixture = await createFixture()
    const repository = (await fixture.store.findRepository('alice', 'site'))!
    await fixture.store.setBranchProtection(repository.id, 'main', {
      ...DEFAULT_PROTECTION,
      requiredPullRequestReviews: { requiredApprovingReviewCount: 1, dismissStaleReviews: true, requireCodeOwnerReviews: false, requireLastPushApproval: false },
      requiredStatusChecks: { strict: false, contexts: ['ci'] },
    })
    const carol = await fixture.scope('carol')
    const bob = await fixture.scope('bob')
    const alice = await fixture.scope('alice')
    await createPull(carol, { title: 'Add docs', head: 'feature', base: 'main' })
    expect(await getPull(bob, 1)).toMatchObject({ mergeableState: 'blocked', blockers: ['1 approving review is required', 'required status check "ci" is expected'] })
    expect((await caught(createReview(carol, 1, { event: 'APPROVE' }))).message).toBe('Can not approve your own pull request')
    await createReview(await fixture.scope('dave'), 1, { event: 'APPROVE' })
    expect((await getPull(bob, 1)).blockers).toContain('1 approving review is required')
    await createReview(bob, 1, { event: 'APPROVE', body: 'LGTM' })
    expect((await caught(mergePull(bob, 1))).message).toBe('Repository rule violations found: required status check "ci" is expected')
    await createStatus(bob, fixture.rev('feature'), { state: 'failure', context: 'ci' })
    expect((await getPull(bob, 1)).blockers).toEqual(['required status check "ci" has not succeeded'])
    await createStatus(bob, fixture.rev('feature'), { state: 'success', context: 'ci' })
    expect((await getPull(bob, 1)).mergeableState).toBe('clean')

    git(fixture.dir, ['checkout', '-q', 'feature'])
    writeFile(fixture.dir, 'docs/new.md', 'new docs, improved\n')
    commitAll(fixture.dir, 'feature: improve docs')
    git(fixture.dir, ['checkout', '-q', 'main'])
    const pushed = await fixture.sync(['feature'])
    await handlePushedRefs(await fixture.scope('alice'), pushed, { kind: 'user', id: fixture.users.carol.id })
    expect((await listReviews(bob, 1)).map((review) => [review.author.login, review.state])).toEqual([
      ['dave', 'DISMISSED'],
      ['bob', 'DISMISSED'],
    ])
    expect((await listEvents(bob, 1)).map((event) => event.event)).toEqual(['reviewed', 'reviewed', 'synchronize', 'review_dismissed', 'review_dismissed'])
    expect((await getPull(bob, 1)).blockers).toEqual(['1 approving review is required', 'required status check "ci" is expected'])
    await createReview(bob, 1, { event: 'REQUEST_CHANGES', body: 'One more thing' })
    expect((await getPull(bob, 1)).blockers).toContain('changes were requested by a reviewer')
    expect((await getPull(alice, 1)).blockers).toEqual([])
    const pending = await createReview(alice, 1, { body: 'Draft' })
    expect(pending.state).toBe('PENDING')
    expect((await listReviews(bob, 1)).map((review) => review.id)).not.toContain(pending.id)
    await submitReview(alice, 1, pending.id, { event: 'APPROVE' })
    const changes = (await listReviews(bob, 1)).find((review) => review.state === 'CHANGES_REQUESTED')!
    await dismissReview(alice, 1, changes.id, 'Addressed')
    await createStatus(bob, fixture.rev('feature'), { state: 'success', context: 'ci' })
    expect(await getPull(bob, 1)).toMatchObject({ mergeableState: 'clean', blockers: [] })
    expect((await mergePull(bob, 1)).merged).toBe(true)
  })

  it('requires approvals from code owners of every owned file and requests reviews from them', async () => {
    const fixture = await createFixture({
      history: (dir) => {
        writeFile(dir, 'README.md', lines(20))
        writeFile(dir, '.github/CODEOWNERS', '*.md @alice\n/docs/ @acme/writers\nsrc/ bob@example.org\n')
        commitAll(dir, 'initial')
        git(dir, ['checkout', '-q', '-b', 'feature'])
        writeFile(dir, 'README.md', lines(20).replace('line 15\n', 'feature line\n'))
        writeFile(dir, 'docs/guide/new.txt', 'new docs\n')
        commitAll(dir, 'feature: docs')
        git(dir, ['checkout', '-q', 'main'])
      },
    })
    const { store } = fixture
    const organization = await store.createOrganization({ login: 'acme' })
    await store.setOrganizationMember(organization.id, fixture.users.bob.id, 'member')
    const team = await store.createTeam(organization.id, { slug: 'writers', name: 'Writers' })
    await store.setTeamMember(team.id, fixture.users.bob.id)
    const repository = (await store.findRepository('alice', 'site'))!
    await store.setBranchProtection(repository.id, 'main', {
      ...DEFAULT_PROTECTION,
      requiredPullRequestReviews: { requiredApprovingReviewCount: 1, dismissStaleReviews: false, requireCodeOwnerReviews: true, requireLastPushApproval: false },
    })
    const carol = await fixture.scope('carol')
    const bob = await fixture.scope('bob')
    const created = await createPull(carol, { title: 'Docs', head: 'feature', base: 'main' })
    expect(created.requestedReviewers.map((user) => user.login)).toEqual(['alice'])
    expect((await listEvents(bob, 1)).map((event) => event.event)).toEqual(['review_requested'])
    expect(await getPull(bob, 1)).toMatchObject({ mergeableState: 'blocked', blockers: ['1 approving review is required', 'review from a code owner is required'] })
    await createReview(bob, 1, { event: 'APPROVE' })
    expect(await pullCodeOwners(bob, 1)).toEqual({
      file: '.github/CODEOWNERS',
      errors: [],
      approved: false,
      files: [
        { path: 'README.md', owners: ['@alice'], approvedBy: [] },
        { path: 'docs/guide/new.txt', owners: ['@acme/writers'], approvedBy: ['bob'] },
      ],
    })
    expect((await getPull(bob, 1)).blockers).toEqual(['review from a code owner is required'])
    await createReview(await fixture.scope('alice'), 1, { event: 'APPROVE' })
    expect(await getPull(bob, 1)).toMatchObject({ mergeableState: 'clean', blockers: [] })
  })

  it('anchors line comments to commit, path and line and validates them against the diff', async () => {
    const fixture = await createFixture()
    const carol = await fixture.scope('carol')
    await createPull(carol, { title: 'Add docs', head: 'feature', base: 'main' })
    const bob = await fixture.scope('bob')
    expect((await caught(createReviewComment(bob, 1, { body: 'x', path: 'README.md', line: 1 }))).message).toMatch(/line must be part of the diff/)
    expect((await caught(createReviewComment(bob, 1, { body: 'x', path: 'src/app.ts', line: 1 }))).message).toMatch(/path must be part of the diff/)
    const comment = await createReviewComment(bob, 1, { body: 'Nice line', path: 'README.md', line: 16, side: 'RIGHT' })
    expect(comment).toMatchObject({ path: 'README.md', line: 16, side: 'RIGHT', commitId: fixture.rev('feature'), outdated: false })
    expect(comment.diffHunk).toBe('@@ -13,7 +13,7 @@ line 11\n line 12\n line 13\n line 14\n-line 15\n+feature line')
    const reply = await createReviewComment(carol, 1, { body: 'Thanks', path: undefined, line: undefined, inReplyTo: comment.id })
    expect(reply).toMatchObject({ inReplyToId: comment.id, path: 'README.md', line: 16 })
    await createReview(bob, 1, { event: 'COMMENT', body: 'Overall fine', comments: [{ path: 'README.md', line: 16, side: 'LEFT', body: 'old side', startLine: undefined }] })
    git(fixture.dir, ['checkout', '-q', 'feature'])
    writeFile(fixture.dir, 'README.md', lines(20).replace('line 15\n', 'feature line, revised\n'))
    commitAll(fixture.dir, 'revise readme')
    git(fixture.dir, ['checkout', '-q', 'main'])
    await fixture.sync(['feature'])
    const after = await listReviewComments(bob, 1)
    expect(after.map((entry) => [entry.body, entry.outdated, entry.line, entry.originalLine])).toEqual([
      ['Nice line', true, null, 16],
      ['Thanks', true, null, 16],
      ['old side', true, null, 16],
    ])
  })

  it('marks pull requests merged by a plain git push and closes issues from pushed commits', async () => {
    const fixture = await createFixture()
    const bob = await fixture.scope('bob')
    await createIssue(bob, { title: 'one' })
    await createIssue(bob, { title: 'two' })
    await createPull(bob, { title: 'Add docs', head: 'feature', base: 'main' })
    gitAs(fixture, 'bob', ['merge', '--no-ff', '-q', '-m', 'Merge feature, closes #2', 'feature'])
    const pushed = await fixture.sync(['main'])
    await handlePushedRefs(await fixture.scope('alice'), pushed, { kind: 'user', id: fixture.users.bob.id })
    expect(await getPull(bob, 3)).toMatchObject({ state: 'closed', merged: true, mergeCommitSha: fixture.rev('main'), mergedBy: { login: 'bob' } })
    expect((await getIssue(bob, 1)).state).toBe('closed')
    expect((await getIssue(bob, 2)).state).toBe('closed')
    expect((await listEvents(bob, 2)).at(-1)).toMatchObject({ event: 'closed', data: { commit_id: fixture.rev('main') } })
  })
})
