import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DEFAULT_PROTECTION } from '@git-forge/accounts'
import { handleGitRequest, lfsObjectSize, readRefs, utf8 } from '@git-forge/core'
import { commitAll, git, gitEnv, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { startServer } from '@git-forge/core/test/http-server.ts'
import { describe, expect, it } from 'vitest'
import {
  CollaborationError,
  commitChanges,
  editPlan,
  getIssue,
  getPull,
  handleCollaborationApi,
  pullConflicts,
  resolvePullConflicts,
  setLocked,
  toggleReaction,
  createIssue,
  viewerReactions,
  createPull,
  openRepository,
} from '../src/index.ts'
import { createFixture, type Fixture } from './fixture.ts'

const caught = async (promise: Promise<unknown>): Promise<CollaborationError> => {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  )
  if (!(error instanceof CollaborationError)) throw new Error(`expected a CollaborationError, got ${String(error)}`)
  return error
}

const clone = async (fixture: Fixture, repo: string, branch: string) => {
  const server = await startServer(async (request) => (await handleGitRequest(request, { storage: fixture.storage })) ?? new Response('not found', { status: 404 }))
  try {
    const dir = join(tempDir(), 'clone')
    await promisify(execFile)('git', ['clone', '-q', '-b', branch, `${server.url}/${repo}.git`, dir], { env: { ...process.env, ...gitEnv } })
    git(dir, ['fsck', '--strict', '--no-dangling'])
    return dir
  } finally {
    await server.close()
  }
}

const BASE = 'https://forge.example'

const api = (fixture: Fixture) => async (method: string, path: string, user: 'alice' | 'bob' | 'carol' | 'dave' | 'erin', body?: unknown) => {
  const response = (await handleCollaborationApi(
    new Request(`${BASE}/api/v3${path}`, { method, headers: { Authorization: `token ${fixture.users[user].token}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
    { ...fixture.options, publicUrl: BASE },
  ))!
  const text = await response.text()
  return { status: response.status, body: (text === '' ? null : JSON.parse(text)) as Record<string, any> }
}

describe('commits from the browser', () => {
  it('commits directly for writers and produces history git accepts', async () => {
    const fixture = await createFixture({ visibility: 'public' })
    const bob = await fixture.scope('bob')
    expect(await editPlan(bob, 'main')).toEqual({ mode: 'direct', problems: [] })
    expect(await editPlan(await fixture.scope('carol'), 'main')).toEqual({ mode: 'fork', problems: [] })
    expect(await editPlan(await fixture.scope('anonymous'), 'main')).toBeNull()
    const readme = git(fixture.dir, ['rev-parse', 'main:README.md']).trim()
    const outcome = await commitChanges(bob, {
      branch: 'main',
      message: 'Edit README\n\nFrom the browser',
      files: [
        { path: 'README.md', content: utf8('edited\n'), sha: readme },
        { path: 'docs/guide/new.md', content: new Blob(['# Guide\n']) },
        { path: 'src/app.ts', content: null },
      ],
    })
    expect(outcome).toMatchObject({ branch: 'main', parent: fixture.rev('main'), repository: { owner: 'alice', name: 'site' }, pull: null })
    expect((await readRefs(fixture.storage, { owner: 'alice', name: 'site' }))!.state.refs['refs/heads/main']).toBe(outcome.sha)
    expect((await caught(commitChanges(bob, { branch: 'main', message: 'again', files: [{ path: 'README.md', content: utf8('x\n'), sha: readme }] }))).status).toBe(409)
    expect((await caught(commitChanges(bob, { branch: 'main', message: 'x', files: [{ path: '../x', content: utf8('x') }] }))).status).toBe(422)
    expect((await caught(commitChanges(bob, { branch: 'nope', message: 'x', files: [{ path: 'x', content: utf8('x') }] }))).status).toBe(404)
    const dir = await clone(fixture, 'alice/site', 'main')
    expect(git(dir, ['log', '-1', '--format=%an <%ae>|%s|%P'])).toBe(`Bob <bob@example.org>|Edit README|${fixture.rev('main')}\n`)
    expect(git(dir, ['diff', '--name-status', 'HEAD~1', 'HEAD']).trim().split('\n')).toEqual(['M\tREADME.md', 'A\tdocs/guide/new.md', 'D\tsrc/app.ts'])
    expect(readFileSync(join(dir, 'docs/guide/new.md'), 'utf8')).toBe('# Guide\n')
  })

  it('sends protected branches through a new branch and a pull request', async () => {
    const fixture = await createFixture()
    const repository = (await fixture.store.findRepository('alice', 'site'))!
    await fixture.store.setBranchProtection(repository.id, 'main', {
      ...DEFAULT_PROTECTION,
      requiredPullRequestReviews: { requiredApprovingReviewCount: 1, dismissStaleReviews: false, requireCodeOwnerReviews: false, requireLastPushApproval: false },
    })
    const bob = await fixture.scope('bob')
    expect(await editPlan(bob, 'main')).toEqual({ mode: 'branch', problems: ['changes must be made through a pull request'] })
    const files = [{ path: 'NEW.md', content: utf8('new\n') }]
    expect((await caught(commitChanges(bob, { branch: 'main', message: 'Add', files }))).status).toBe(409)
    const outcome = await commitChanges(bob, { branch: 'main', message: 'Add NEW', files, newBranch: 'bob/new', pull: { title: '', body: 'Please review' } })
    expect(outcome).toMatchObject({ branch: 'bob/new', pull: { title: 'Add NEW', body: 'Please review', headRef: 'bob/new', baseRef: 'main', headSha: outcome.sha } })
    expect((await caught(commitChanges(bob, { branch: 'main', message: 'Add', files, newBranch: 'bob/new' }))).message).toBe('Branch bob/new already exists')
  })

  it('proposes changes from users without write access through their fork', async () => {
    const fixture = await createFixture()
    const carol = await fixture.scope('carol')
    expect((await caught(commitChanges(carol, { branch: 'main', message: 'x', files: [{ path: 'x', content: utf8('x') }] }))).status).toBe(403)
    const outcome = await commitChanges(carol, { branch: 'main', message: 'Fix typo', propose: true, files: [{ path: 'README.md', content: utf8('fixed\n') }] })
    expect(outcome).toMatchObject({ repository: { owner: 'carol', name: 'site' }, branch: 'patch-1', parent: fixture.rev('main') })
    expect(outcome.pull).toMatchObject({ number: 1, title: 'Fix typo', headRef: 'patch-1', headRepository: { owner: 'carol', name: 'site' }, headSha: outcome.sha, mergeable: true })
    const second = await commitChanges(carol, { branch: 'main', message: 'Another', propose: true, files: [{ path: 'OTHER.md', content: utf8('o\n') }] })
    expect(second).toMatchObject({ repository: { owner: 'carol', name: 'site' }, branch: 'patch-2' })
    const dir = await clone(fixture, 'carol/site', 'patch-1')
    expect(git(dir, ['log', '-1', '--format=%an|%P'])).toBe(`Carol|${fixture.rev('main')}\n`)
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('fixed\n')
  })

  it('stores uploads of LFS-tracked paths as pointers and LFS objects', async () => {
    const fixture = await createFixture({
      history: (dir) => {
        writeFile(dir, '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n')
        writeFile(dir, 'README.md', 'readme\n')
        commitAll(dir, 'initial')
      },
    })
    const options = { ...fixture.options, lfs: { maxObjectBytes: 16 } }
    const bob = await openRepository(options, fixture.users.bob.principal, 'alice', 'site')
    const data = new Uint8Array([0, 1, 2, 3, 4, 5])
    const outcome = await commitChanges(bob, { branch: 'main', message: 'Add data', files: [{ path: 'assets/data.bin', content: new Blob([data]) }] })
    const oid = Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex')
    expect(await lfsObjectSize(fixture.storage, { owner: 'alice', name: 'site' }, oid)).toBe(6)
    const dir = await clone(fixture, 'alice/site', 'main')
    expect(readFileSync(join(dir, 'assets/data.bin'), 'utf8')).toBe(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 6\n`)
    expect(outcome.parent).toBe(fixture.rev('main'))
    const big = await caught(commitChanges(bob, { branch: 'main', message: 'Big', files: [{ path: 'big.bin', content: new Uint8Array(17) }] }))
    expect(big.message).toBe('big.bin is larger than the Git LFS limit of 16 bytes; push it with git lfs')
  })

  it('serves the contents API with GitHub semantics', async () => {
    const fixture = await createFixture()
    const call = api(fixture)
    const encoded = Buffer.from('hello\n').toString('base64')
    const created = await call('PUT', '/repos/alice/site/contents/notes/hello.txt', 'bob', { message: 'Add hello', content: encoded })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ content: { type: 'file', name: 'hello.txt', path: 'notes/hello.txt', size: 6 }, commit: { message: 'Add hello', author: { name: 'Bob', email: 'bob@example.org' }, parents: [{ sha: fixture.rev('main') }] } })
    const read = await call('GET', '/repos/alice/site/contents/notes/hello.txt', 'carol')
    expect(read.body).toMatchObject({ type: 'file', encoding: 'base64', sha: created.body.content.sha, content: `${encoded}` })
    expect((await call('GET', '/repos/alice/site/contents/notes', 'carol')).body).toMatchObject([{ type: 'file', name: 'hello.txt' }])
    expect((await call('GET', '/repos/alice/site/contents/?ref=feature', 'carol')).body.map((entry: { name: string }) => entry.name)).toEqual(['README.md', 'docs', 'src'])
    expect((await call('PUT', '/repos/alice/site/contents/notes/hello.txt', 'bob', { message: 'Update', content: encoded })).status).toBe(422)
    expect((await call('PUT', '/repos/alice/site/contents/notes/hello.txt', 'bob', { message: 'Update', content: encoded, sha: 'a'.repeat(40) })).status).toBe(409)
    expect((await call('PUT', '/repos/alice/site/contents/notes/hello.txt', 'carol', { message: 'Update', content: encoded, sha: created.body.content.sha })).status).toBe(403)
    const updated = await call('PUT', '/repos/alice/site/contents/notes/hello.txt', 'bob', { message: 'Update', content: Buffer.from('bye\n').toString('base64'), sha: created.body.content.sha, branch: 'feature' })
    expect(updated.status).toBe(409)
    const onMain = await call('PUT', '/repos/alice/site/contents/notes/hello.txt', 'bob', { message: 'Update', content: Buffer.from('bye\n').toString('base64'), sha: created.body.content.sha })
    expect(onMain.status).toBe(200)
    expect((await call('DELETE', '/repos/alice/site/contents/notes/hello.txt', 'bob', { message: 'Remove' })).status).toBe(422)
    const removed = await call('DELETE', '/repos/alice/site/contents/notes/hello.txt', 'bob', { message: 'Remove', sha: onMain.body.content.sha })
    expect(removed.body).toMatchObject({ content: null, commit: { message: 'Remove', parents: [{ sha: onMain.body.commit.sha }] } })
    expect((await call('GET', '/repos/alice/site/contents/notes/hello.txt', 'bob')).status).toBe(404)
  })
})

describe('conflict resolution in the browser', () => {
  it('lists conflicts with markers and commits the resolution as a merge of base into head', async () => {
    const fixture = await createFixture()
    const carol = await fixture.scope('carol')
    const bob = await fixture.scope('bob')
    const pull = await createPull(bob, { title: 'Conflict', head: 'conflict', base: 'main' })
    expect(pull.mergeable).toBe(false)
    const conflicts = await pullConflicts(bob, pull.number)
    expect(conflicts).toMatchObject({ writable: true, headBranch: 'conflict', baseBranch: 'main', files: [{ path: 'src/app.ts', reason: 'content' }] })
    expect(conflicts.files[0]!.text).toContain('<<<<<<< conflict\nconflicting change\n=======\nmain change\n>>>>>>> main\n')
    expect((await pullConflicts(carol, pull.number)).writable).toBe(false)
    expect((await caught(resolvePullConflicts(carol, pull.number, { resolutions: new Map() }))).status).toBe(403)
    expect((await caught(resolvePullConflicts(bob, pull.number, { resolutions: new Map([['src/app.ts', conflicts.files[0]!.text!]]) }))).status).toBe(422)
    const resolved = conflicts.files[0]!.text!.replace(/<<<<<<< conflict\nconflicting change\n=======\nmain change\n>>>>>>> main\n/, 'both changes\n')
    const sha = await resolvePullConflicts(bob, pull.number, { resolutions: new Map([['src/app.ts', resolved]]), sha: conflicts.head })
    expect(await getPull(bob, pull.number)).toMatchObject({ headSha: sha, mergeable: true })
    const dir = await clone(fixture, 'alice/site', 'conflict')
    expect(git(dir, ['log', '-1', '--format=%P|%s'])).toBe(`${fixture.rev('conflict')} ${fixture.rev('main')}|Merge branch 'main' into conflict\n`)
    expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).toBe(resolved)
  })
})

describe('reactions', () => {
  it('reacts to issues and comments through the API and the toggle', async () => {
    const fixture = await createFixture()
    const call = api(fixture)
    await createIssue(await fixture.scope('bob'), { title: 'Bug' })
    const comment = await call('POST', '/repos/alice/site/issues/1/comments', 'bob', { body: 'Same here' })
    const first = await call('POST', '/repos/alice/site/issues/1/reactions', 'carol', { content: 'heart' })
    expect(first).toMatchObject({ status: 201, body: { content: 'heart', user: { login: 'carol' } } })
    expect((await call('POST', '/repos/alice/site/issues/1/reactions', 'carol', { content: 'heart' })).status).toBe(200)
    expect((await call('POST', '/repos/alice/site/issues/1/reactions', 'carol', { content: 'party' })).status).toBe(422)
    await call('POST', '/repos/alice/site/issues/1/reactions', 'bob', { content: '+1' })
    await call('POST', `/repos/alice/site/issues/comments/${comment.body.id}/reactions`, 'dave', { content: 'rocket' })
    expect((await call('GET', '/repos/alice/site/issues/1', 'erin')).status).toBe(404)
    expect((await call('GET', '/repos/alice/site/issues/1', 'bob')).body.reactions).toMatchObject({ total_count: 2, '+1': 1, heart: 1, rocket: 0, url: `${BASE}/api/v3/repos/alice/site/issues/1/reactions` })
    expect((await call('GET', `/repos/alice/site/issues/comments/${comment.body.id}`, 'bob')).body.reactions).toMatchObject({ total_count: 1, rocket: 1 })
    expect((await call('GET', '/repos/alice/site/issues/1/reactions?content=heart', 'bob')).body.map((reaction: { user: { login: string } }) => reaction.user.login)).toEqual(['carol'])
    expect((await call('DELETE', `/repos/alice/site/issues/1/reactions/${first.body.id}`, 'bob')).status).toBe(403)
    expect((await call('DELETE', `/repos/alice/site/issues/1/reactions/${first.body.id}`, 'carol')).status).toBe(204)
    const carol = await fixture.scope('carol')
    const issue = await getIssue(carol, 1)
    await toggleReaction(carol, { kind: 'issue', id: 1 }, 'eyes')
    expect(await viewerReactions(carol, 'issue', [issue.id])).toEqual(new Set([`${issue.id}:eyes`]))
    await toggleReaction(carol, { kind: 'issue', id: 1 }, 'eyes')
    expect(await viewerReactions(carol, 'issue', [issue.id])).toEqual(new Set())
    await setLocked(await fixture.scope('bob'), 1, true)
    expect((await call('POST', '/repos/alice/site/issues/1/reactions', 'carol', { content: 'heart' })).status).toBe(403)
  })
})
