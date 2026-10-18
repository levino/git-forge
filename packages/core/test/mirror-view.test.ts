import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { readAll } from '../src/bytes.ts'

import { configureMirror, detachMirror, syncMirror } from '../src/mirror.ts'
import { advertisedRefs, createRepository, gitPrefix, readRefs, type RefsState, type RepositoryName } from '../src/repository.ts'
import { commitAll, gitEnv, initRepo, tempDir, writeFile } from './git-helpers.ts'
import { type Forge, startForge } from './mirror-helpers.ts'

const run = promisify(execFile)

const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (await run('git', args, { cwd, env: { ...process.env, ...gitEnv }, maxBuffer: 64 * 1024 * 1024 })).stdout

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

describe('mirror view', () => {
  it('shows upstream branches and tags as refs/heads and refs/tags, own refs first', () => {
    const state: RefsState = {
      head: 'refs/heads/main',
      refs: {
        'refs/upstream/origin/heads/develop': A,
        'refs/upstream/origin/heads/main': B,
        'refs/upstream/origin/tags/v1': C,
        'refs/upstream/other/heads/x': C,
        'refs/heads/main': C,
        'refs/archive/2026/upstream/origin/heads/main': A,
      },
      mirrorView: { remote: 'origin', head: 'refs/heads/develop' },
    }
    expect(advertisedRefs(state)).toEqual({
      head: 'refs/heads/develop',
      refs: { ...state.refs, 'refs/heads/develop': A, 'refs/tags/v1': C },
    })
    expect(advertisedRefs({ ...state, mirrorView: { remote: 'origin', head: 'refs/heads/gone' } }).head).toBe('refs/heads/main')
    expect(advertisedRefs({ head: 'refs/heads/main', refs: state.refs })).toEqual({ head: 'refs/heads/main', refs: state.refs })
  })
})

const servers: Forge[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((forge) => forge.server.close()))
})

const project: RepositoryName = { owner: 'village', name: 'archive' }
const backup: RepositoryName = { owner: 'backup', name: 'archive' }

const setup = async (strategy: 'copy' | 'fetch') => {
  const upstream = await startForge()
  const downstream = await startForge()
  servers.push(upstream, downstream)
  await createRepository(upstream.storage, project, 'develop')
  await downstream.createRepo(backup)
  await configureMirror(downstream.storage, backup, { url: upstream.url(project), lfs: false })
  const source = initRepo()
  writeFile(source, 'README.md', 'on main\n')
  commitAll(source, 'main')
  await git(source, ['checkout', '-q', '-b', 'develop'])
  writeFile(source, 'develop.txt', 'on develop\n')
  const develop = commitAll(source, 'develop')
  await git(source, ['tag', 'v1'])
  await git(source, ['push', '-q', upstream.url(project), 'main', 'develop', '--tags'])
  const sync = () => syncMirror({ storage: downstream.storage, repo: backup, strategy })
  expect((await sync()).status).toBe('ok')
  return { upstream, downstream, source, develop, sync }
}

const cloneHead = async (url: string, protocol: '2' | '0') => {
  const dir = tempDir()
  await git(dir, ['-c', `protocol.version=${protocol}`, 'clone', '-q', url, 'out'])
  return {
    branch: (await git(`${dir}/out`, ['symbolic-ref', '--short', 'HEAD'])).trim(),
    tip: (await git(`${dir}/out`, ['rev-parse', 'HEAD'])).trim(),
    branches: (await git(`${dir}/out`, ['branch', '-r', '--format=%(refname:short)'])).trim().split('\n'),
    tags: (await git(`${dir}/out`, ['tag'])).trim(),
    dir: `${dir}/out`,
  }
}

describe.each(['copy', 'fetch'] as const)('plain clones of a mirror (%s sync)', (strategy) => {
  it('check out the upstream default branch over smart and dumb HTTP', async () => {
    const { downstream, develop } = await setup(strategy)
    for (const protocol of ['2', '0'] as const) {
      const clone = await cloneHead(downstream.url(backup), protocol)
      expect(clone).toMatchObject({ branch: 'develop', tip: develop, tags: 'v1' })
      expect(clone.branches).toEqual(expect.arrayContaining(['origin/develop', 'origin/main']))
    }
    const head = await downstream.storage.get(`${gitPrefix(backup)}HEAD`)
    expect(new TextDecoder().decode(await readAll(head!.body))).toBe('ref: refs/heads/develop\n')
    const stored = (await readRefs(downstream.storage, backup))!.state
    expect(Object.keys(stored.refs).filter((name) => name.startsWith('refs/heads/'))).toEqual([])
    expect(stored.mirrorView).toEqual({ remote: 'origin', head: 'refs/heads/develop' })
  })
})

describe('the mirror view on writes and detach', () => {
  it('lets own pushes shadow the view and keeps them out of the upstream view', async () => {
    const { downstream, upstream, source, sync } = await setup('copy')
    const work = tempDir()
    await git(work, ['clone', '-q', downstream.url(backup), 'w'])
    writeFile(`${work}/w`, 'local.txt', 'downstream work\n')
    const own = commitAll(`${work}/w`, 'own work')
    await git(`${work}/w`, ['push', '-q', 'origin', 'develop'])
    const stored = (await readRefs(downstream.storage, backup))!.state
    expect(stored.refs['refs/heads/develop']).toBe(own)
    expect((await cloneHead(downstream.url(backup), '2')).tip).toBe(own)

    writeFile(source, 'later.txt', 'later\n')
    const later = commitAll(source, 'later upstream')
    await git(source, ['push', '-q', upstream.url(project), 'develop'])
    expect((await sync()).status).toBe('ok')
    const after = (await readRefs(downstream.storage, backup))!.state
    expect(after.refs['refs/upstream/origin/heads/develop']).toBe(later)
    expect(after.refs['refs/heads/develop']).toBe(own)
    expect((await cloneHead(downstream.url(backup), '2')).tip).toBe(own)
  })

  it('turns the view into real branches and tags on detach', async () => {
    const { downstream, develop } = await setup('copy')
    await detachMirror(downstream.storage, backup)
    const stored = (await readRefs(downstream.storage, backup))!.state
    expect(stored.mirrorView).toBeUndefined()
    expect(stored.head).toBe('refs/heads/develop')
    expect(stored.refs['refs/heads/develop']).toBe(develop)
    expect(stored.refs['refs/tags/v1']).toBe(develop)
    expect(stored.refs['refs/upstream/origin/heads/develop']).toBe(develop)
    for (const protocol of ['2', '0'] as const) expect(await cloneHead(downstream.url(backup), protocol)).toMatchObject({ branch: 'develop', tip: develop })
    const work = (await cloneHead(downstream.url(backup), '2')).dir
    writeFile(work, 'after-detach.txt', 'continues as primary\n')
    const next = commitAll(work, 'after detach')
    await git(work, ['push', '-q', 'origin', 'develop'])
    expect((await readRefs(downstream.storage, backup))!.state.refs['refs/heads/develop']).toBe(next)
  })
})

