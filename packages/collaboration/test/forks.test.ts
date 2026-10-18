import { ObjectDatabase, readRefs, streamOf, updateRefs, ZERO_ID } from '@git-forge/core'
import { commitAll, git, gitBytes, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { describe, expect, it } from 'vitest'
import {
  CollaborationError,
  createFork,
  createPull,
  forkNetwork,
  getPull,
  handlePushedRefs,
  listEvents,
  listForks,
  maintainerPushBranches,
  mergePull,
  openRepository,
  pullFiles,
  systemScope,
  updatePull,
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

const pushTo = async (fixture: Fixture, repo: { owner: string; name: string }, branch: string) => {
  const odb = new ObjectDatabase(fixture.storage, repo)
  await odb.ingest(streamOf(gitBytes(fixture.dir, ['pack-objects', '--stdout', '--all'], '')))
  const name = `refs/heads/${branch}`
  const oldId = (await readRefs(fixture.storage, repo))!.state.refs[name] ?? ZERO_ID
  const newId = fixture.rev(branch)
  if (!(await updateRefs(fixture.storage, repo, [{ name, oldId, newId }], odb)).ok) throw new Error('push failed')
  return [{ name, oldId, newId }]
}

describe('forks', () => {
  it('forks within the instance, opens pull requests from the fork and merges them', async () => {
    const fixture = await createFixture()
    const carol = await fixture.scope('carol')
    const fork = await createFork(carol, {})
    expect(fork).toMatchObject({ owner: 'carol', name: 'site', visibility: 'private' })
    expect((await caught(createFork(carol, {}))).status).toBe(422)
    const carolFork = await openRepository(fixture.options, fixture.users.carol.principal, 'carol', 'site')
    expect((await readRefs(fixture.storage, { owner: 'carol', name: 'site' }))!.state.refs['refs/heads/main']).toBe(fixture.rev('main'))
    expect(await listForks(await fixture.scope('alice'))).toEqual([])
    expect((await listForks(carol)).map((repository) => `${repository.owner}/${repository.name}`)).toEqual(['carol/site'])
    expect(await forkNetwork(carolFork)).toMatchObject({ root: { owner: 'alice', name: 'site' }, forks: [{ owner: 'carol', name: 'site' }] })

    git(fixture.dir, ['checkout', '-q', '-b', 'fix', 'main'])
    writeFile(fixture.dir, 'src/fix.ts', 'export const fix = 1\n')
    commitAll(fixture.dir, 'Add fix')
    git(fixture.dir, ['checkout', '-q', 'main'])
    await pushTo(fixture, { owner: 'carol', name: 'site' }, 'fix')
    expect(await new ObjectDatabase(fixture.storage, { owner: 'alice', name: 'site' }).has(fixture.rev('fix'))).toBe(false)

    const pull = await createPull(carol, { title: 'Fix', head: 'carol:fix', base: 'main', maintainerCanModify: true })
    expect(pull).toMatchObject({ headRef: 'fix', headSha: fixture.rev('fix'), headRepository: { owner: 'carol', name: 'site' }, maintainerCanModify: true, mergeable: true })
    expect(await new ObjectDatabase(fixture.storage, { owner: 'alice', name: 'site' }).has(fixture.rev('fix'))).toBe(true)
    expect((await pullFiles(carol, pull.number)).map((file) => file.path)).toEqual(['src/fix.ts'])
    expect((await caught(createPull(carol, { title: 'Again', head: 'carol:fix', base: 'main' }))).message).toBe('A pull request already exists for carol:fix.')
    expect((await caught(createPull(carol, { title: 'Nope', head: 'erin:fix', base: 'main' }))).status).toBe(422)

    expect(await maintainerPushBranches(fixture.options, fixture.users.bob.principal, fork)).toEqual(['refs/heads/fix'])
    expect(await maintainerPushBranches(fixture.options, fixture.users.dave.principal, fork)).toEqual([])
    expect((await caught(updatePull(await fixture.scope('bob'), pull.number, { maintainerCanModify: false }))).status).toBe(403)

    git(fixture.dir, ['checkout', '-q', 'fix'])
    writeFile(fixture.dir, 'src/fix.ts', 'export const fix = 2\n')
    commitAll(fixture.dir, 'Improve fix')
    git(fixture.dir, ['checkout', '-q', 'main'])
    const pushed = await pushTo(fixture, { owner: 'carol', name: 'site' }, 'fix')
    await handlePushedRefs((await systemScope(fixture.options, 'carol', 'site'))!, pushed, { kind: 'user', id: fixture.users.carol.id })
    const bob = await fixture.scope('bob')
    expect((await listEvents(bob, pull.number)).map((event) => event.event)).toEqual(['synchronize'])
    expect((await getPull(bob, pull.number)).headSha).toBe(fixture.rev('fix'))

    await updatePull(carol, pull.number, { maintainerCanModify: false })
    expect(await maintainerPushBranches(fixture.options, fixture.users.bob.principal, fork)).toEqual([])
    const merged = await mergePull(bob, pull.number)
    const odb = new ObjectDatabase(fixture.storage, { owner: 'alice', name: 'site' })
    const message = new TextDecoder().decode((await odb.read(merged.sha))!.data)
    expect(message).toContain('Merge pull request #1 from carol/fix')
    expect((await readRefs(fixture.storage, { owner: 'alice', name: 'site' }))!.state.refs['refs/heads/main']).toBe(merged.sha)
  })
})
