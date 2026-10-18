import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commitChanges,
  commitLog,
  defaultBranch,
  lastCommitFor,
  namedRefs,
  readBlobContent,
  readCommit,
  resolveRefAndPath,
  resolveTarget,
} from '../src/browse.ts'
import { diffFile, diffTrees } from '../src/diff.ts'
import { ObjectDatabase, readRefs, type RefsState } from '../src/repository.ts'
import { commitAll, git, gitEnv, initRepo, writeFile } from './git-helpers.ts'
import { type Forge, startForge } from './mirror-helpers.ts'

const repo = { owner: 'acme', name: 'site' }

let forge: Forge
let dir: string
let ids: string[]
let odb: ObjectDatabase
let refs: RefsState

beforeAll(async () => {
  forge = await startForge()
  const url = await forge.createRepo(repo)
  dir = initRepo()
  writeFile(dir, 'README.md', '# Site\n')
  writeFile(dir, 'src/a.ts', 'export const a = 1\n')
  const first = commitAll(dir, 'first commit\n\nwith a body')
  writeFile(dir, 'src/a.ts', 'export const a = 2\n')
  writeFile(dir, 'src/b/c.ts', 'export const c = 3\n')
  writeFile(dir, 'logo.bin', new Uint8Array([0, 1, 2, 3]))
  const second = commitAll(dir, 'second')
  git(dir, ['rm', '-q', 'README.md'])
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const third = commitAll(dir, 'third')
  git(dir, ['tag', '-a', 'v1', '-m', 'release', first])
  git(dir, ['branch', 'feature/x', second])
  await promisify(execFile)('git', ['push', '-q', url, 'main', 'feature/x', 'v1'], { cwd: dir, env: { ...process.env, ...gitEnv } })
  ids = [first, second, third]
  odb = new ObjectDatabase(forge.storage, repo)
  refs = (await readRefs(forge.storage, repo))!.state
}, 60_000)

afterAll(async () => {
  await forge.server.close()
})

describe('browse', () => {
  it('parses commits and signatures', async () => {
    const commit = await readCommit(odb, ids[0]!)
    expect(commit).toMatchObject({ summary: 'first commit', parents: [], author: { name: 'Test', email: 'test@example.org', timestamp: 1767225600, timezone: '+0000' } })
    expect(commit!.message).toBe('first commit\n\nwith a body\n')
  })

  it('lists refs and resolves refs with slashes, tags and commit ids', async () => {
    const named = namedRefs(refs)
    expect(named.branches.map((branch) => branch.name)).toEqual(['feature/x', 'main'])
    expect(named.tags.map((tag) => tag.name)).toEqual(['v1'])
    expect(defaultBranch(refs)).toBe('main')
    expect(await resolveRefAndPath(odb, refs, ['feature', 'x', 'src', 'a.ts'])).toEqual({ commit: ids[1], ref: 'feature/x', immutable: false, path: ['src', 'a.ts'] })
    expect(await resolveRefAndPath(odb, refs, ['v1'])).toEqual({ commit: ids[0], ref: 'v1', immutable: false, path: [] })
    expect(await resolveRefAndPath(odb, refs, [ids[1]!, 'src'])).toMatchObject({ commit: ids[1], immutable: true, path: ['src'] })
    expect(await resolveRefAndPath(odb, refs, ['nope'])).toBeNull()
  })

  it('resolves trees, blobs and missing paths', async () => {
    const root = await resolveTarget(odb, ids[1]!, [])
    expect(root?.kind === 'tree' && root.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(['tree:src', 'blob:README.md', 'blob:logo.bin'])
    const blob = await resolveTarget(odb, ids[1]!, ['src', 'b', 'c.ts'])
    expect(blob?.kind).toBe('blob')
    expect(blob?.kind === 'blob' && (await readBlobContent(odb, blob.entry))).toEqual({ kind: 'text', text: 'export const c = 3\n', size: 19 })
    const binary = await resolveTarget(odb, ids[1]!, ['logo.bin'])
    expect(binary?.kind === 'blob' && (await readBlobContent(odb, binary.entry))).toEqual({ kind: 'binary', size: 4 })
    expect(await resolveTarget(odb, ids[1]!, ['src', 'missing'])).toBeNull()
    expect(await resolveTarget(odb, ids[1]!, ['logo.bin', 'x'])).toBeNull()
  })

  it('walks the history, pages it and filters by path', async () => {
    expect((await commitLog(odb, ids[2]!, { limit: 10 })).commits.map((commit) => commit.id)).toEqual([...ids].reverse())
    expect(await commitLog(odb, ids[2]!, { limit: 1, skip: 1 })).toMatchObject({ commits: [{ id: ids[1] }], more: true })
    expect((await commitLog(odb, ids[2]!, { limit: 10, path: ['README.md'] })).commits.map((commit) => commit.id)).toEqual([ids[2], ids[0]])
    expect((await lastCommitFor(odb, ids[2]!, ['src']))?.id).toBe(ids[1])
    expect((await commitLog(odb, ids[2]!, { limit: 10, maxWalk: 2 })).commits).toHaveLength(2)
  })

  it('lists the changes of a commit against its first parent', async () => {
    const second = (await readCommit(odb, ids[1]!))!
    const changes = await commitChanges(odb, second)
    expect(changes.map((change) => `${change.status} ${change.path}`)).toEqual(['added logo.bin', 'modified src/a.ts', 'added src/b/c.ts'])
    expect((await diffFile(odb, changes[1]!)).hunks).toHaveLength(1)
    const root = await commitChanges(odb, (await readCommit(odb, ids[0]!))!)
    expect(root.map((change) => change.status)).toEqual(['added', 'added'])
    expect(await diffTrees(odb, second.tree, second.tree)).toEqual([])
  })
})
