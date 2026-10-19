import { describe, expect, it } from 'vitest'
import { commitLog, lastCommitFor } from '../src/browse.ts'
import { computeLastCommits, hasLastCommits, lastCommitsKey, readLastCommits, storeLastCommits } from '../src/last-commits.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { ObjectDatabase } from '../src/repository.ts'
import { git, initRepo, writeFile } from './git-helpers.ts'
import { loadRepository } from './repo-helpers.ts'

let clock = Date.UTC(2026, 0, 1) / 1000
const commit = (dir: string, message: string, args: readonly string[] = []) => {
  clock += 60
  const date = `${clock} +0000`
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '--allow-empty', '-m', message, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

const history = () => {
  const dir = initRepo()
  writeFile(dir, 'README.md', 'a\n')
  writeFile(dir, 'src/a.ts', '1\n')
  writeFile(dir, 'src/lib/b.ts', '1\n')
  writeFile(dir, 'docs/x.md', '1\n')
  commit(dir, 'root')
  writeFile(dir, 'src/a.ts', '2\n')
  const middle = commit(dir, 'change a')
  git(dir, ['checkout', '-q', '-b', 'side'])
  writeFile(dir, 'src/lib/b.ts', 'side\n')
  writeFile(dir, 'side.txt', 's\n')
  commit(dir, 'side work')
  git(dir, ['checkout', '-q', 'main'])
  git(dir, ['rm', '-q', '-r', 'docs'])
  writeFile(dir, 'docs', 'now a file\n')
  commit(dir, 'docs becomes a file')
  clock += 60
  git(dir, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` } })
  const merged = git(dir, ['rev-parse', 'HEAD']).trim()
  writeFile(dir, 'README.md', 'b\n')
  const tip = commit(dir, 'readme')
  return { dir, middle, merged, tip }
}

describe('last commits', () => {
  it('matches the history walk for every path, with and without an earlier map', async () => {
    const { dir, merged, tip } = history()
    const { odb } = await loadRepository(dir, { owner: 'acme', name: 'last' }, new MemoryStorage())
    const full = (await computeLastCommits(odb, tip))!
    const paths = git(dir, ['ls-tree', '-r', '-t', '--name-only', tip]).trim().split('\n')
    expect([...full.keys()].sort()).toEqual([...paths].sort())
    for (const path of paths) expect(full.get(path)).toBe((await lastCommitFor(odb, tip, path.split('/')))?.id ?? null)
    const earlier = (await computeLastCommits(odb, merged))!
    expect(await computeLastCommits(odb, tip, new Map([[merged, earlier]]))).toEqual(full)
    expect(await computeLastCommits(odb, tip, new Map(), 2)).toEqual(new Map(paths.map((path) => [path, path === 'README.md' ? tip : full.get(path) === merged ? merged : null])))
    for (const path of paths) {
      const segments = path.split('/')
      for (const skip of [0, 1]) expect(await commitLog(odb, tip, { limit: 2, skip, path: segments, first: full.get(path)! })).toEqual(await commitLog(odb, tip, { limit: 2, skip, path: segments }))
    }
    expect(await commitLog(odb, tip, { limit: 2, path: ['src'], first: null })).toEqual({ commits: [], more: false })
  })

  it('stores maps append-only by commit id and reads them back', async () => {
    const { dir, tip } = history()
    const { odb, storage, repo } = await loadRepository(dir, { owner: 'acme', name: 'stored' }, new MemoryStorage())
    const map = (await computeLastCommits(odb, tip))!
    expect(await hasLastCommits(odb, tip)).toBe(false)
    await storeLastCommits(odb, tip, map)
    await storeLastCommits(odb, tip, new Map())
    expect(await storage.head(lastCommitsKey(repo, tip))).not.toBeNull()
    expect(await readLastCommits(new ObjectDatabase(storage, { owner: 'acme', name: 'stored' }), tip)).toEqual(map)
    expect(await hasLastCommits(odb, tip)).toBe(true)
    expect(await readLastCommits(odb, '0'.repeat(40))).toBeNull()
  })
})
