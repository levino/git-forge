import { spawnSync } from 'node:child_process'
import { chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCommitDetails, serializeCommit } from '../src/commit.ts'
import { parseSignature } from '../src/objects.ts'
import { checkMergeability, commitsBetween, mergeBases, mergeBranches, type MergeOutcome } from '../src/merge.ts'
import { parseCommit } from '../src/objects.ts'
import { commitAll, git, gitEnv, initRepo, writeFile } from './git-helpers.ts'
import { loadRepository } from './repo-helpers.ts'

const COMMITTER = parseSignature(`${gitEnv.GIT_COMMITTER_NAME} <${gitEnv.GIT_COMMITTER_EMAIL}> ${Date.parse(gitEnv.GIT_COMMITTER_DATE) / 1000} +0000`)!

const rev = (dir: string, ref: string) => git(dir, ['rev-parse', ref]).trim()

const lines = (count: number, tag = '') => Array.from({ length: count }, (_, i) => `line ${i}${tag}\n`).join('')

const edit = (text: string, index: number, replacement: string) => {
  const parts = text.split('\n')
  parts[index] = replacement
  return parts.join('\n')
}

const merged = (outcome: MergeOutcome) => {
  if (!outcome.ok) throw new Error(`merge failed: ${JSON.stringify(outcome)}`)
  return outcome
}

const gitMerge = (dir: string, base: string, head: string, message: string): { clean: boolean; commit: string | null } => {
  git(dir, ['checkout', '-q', '-B', 'probe', base])
  const result = spawnSync('git', ['merge', '--no-ff', '-q', '-m', message, head], { cwd: dir, env: { ...process.env, ...gitEnv }, encoding: 'utf8' })
  if (result.status !== 0) {
    git(dir, ['merge', '--abort'])
    return { clean: false, commit: null }
  }
  return { clean: true, commit: rev(dir, 'HEAD') }
}

const divergent = () => {
  const dir = initRepo()
  writeFile(dir, 'a.txt', lines(30))
  writeFile(dir, 'b.txt', 'b\n')
  writeFile(dir, 'dir/c.txt', 'c\n')
  commitAll(dir, 'base')
  git(dir, ['checkout', '-q', '-b', 'feature'])
  writeFile(dir, 'a.txt', edit(lines(30), 25, 'feature change'))
  writeFile(dir, 'dir/new.txt', 'new\n')
  rmSync(join(dir, 'b.txt'))
  commitAll(dir, 'feature one')
  writeFile(dir, 'dir/c.txt', 'c changed\n')
  commitAll(dir, 'feature two')
  git(dir, ['checkout', '-q', 'main'])
  writeFile(dir, 'a.txt', edit(lines(30), 2, 'main change'))
  writeFile(dir, 'main.txt', 'main\n')
  commitAll(dir, 'main moves on')
  return dir
}

describe('merge strategies against git', () => {
  it('creates the same merge commit as git merge --no-ff', async () => {
    const dir = divergent()
    const { odb } = await loadRepository(dir)
    const message = 'Merge feature'
    const outcome = merged(await mergeBranches(odb, { base: rev(dir, 'main'), head: rev(dir, 'feature'), method: 'merge', message, committer: COMMITTER }))
    const expected = gitMerge(dir, 'main', 'feature', message)
    expect(expected.clean).toBe(true)
    expect(outcome.commit).toBe(expected.commit)
    expect(outcome.objects.map((object) => object.id)).toContain(outcome.tree)
  })

  it('creates the same tree as git merge --squash with one parent', async () => {
    const dir = divergent()
    const { odb } = await loadRepository(dir)
    const outcome = merged(await mergeBranches(odb, { base: rev(dir, 'main'), head: rev(dir, 'feature'), method: 'squash', message: 'Squashed (#1)', committer: COMMITTER }))
    git(dir, ['checkout', '-q', '-B', 'probe', 'main'])
    git(dir, ['merge', '--squash', '-q', 'feature'], { stdio: ['pipe', 'pipe', 'ignore'] })
    git(dir, ['commit', '-q', '-m', 'Squashed (#1)'])
    expect(outcome.commit).toBe(rev(dir, 'HEAD'))
    const commit = parseCommitDetails(outcome.objects.find((object) => object.id === outcome.commit)!.data)
    expect(commit.parents).toEqual([rev(dir, 'main')])
  })

  it('rebases to the same commits as git rebase --force-rebase', async () => {
    const dir = divergent()
    const { odb } = await loadRepository(dir)
    const outcome = merged(await mergeBranches(odb, { base: rev(dir, 'main'), head: rev(dir, 'feature'), method: 'rebase', message: '', committer: COMMITTER }))
    git(dir, ['checkout', '-q', '-B', 'probe', 'feature'])
    git(dir, ['rebase', '-q', '--force-rebase', 'main'])
    expect(outcome.commit).toBe(rev(dir, 'HEAD'))
    expect(outcome.rebased.map((entry) => entry.original)).toEqual([rev(dir, 'feature~1'), rev(dir, 'feature')])
    expect(outcome.rebased.map((entry) => entry.rewritten)).toEqual([rev(dir, 'HEAD~1'), rev(dir, 'HEAD')])
  })

  it('drops commits that are already upstream when rebasing, like git rebase', async () => {
    const dir = initRepo()
    writeFile(dir, 'a.txt', lines(10))
    commitAll(dir, 'base')
    git(dir, ['checkout', '-q', '-b', 'feature'])
    writeFile(dir, 'a.txt', edit(lines(10), 1, 'x'))
    commitAll(dir, 'shared')
    writeFile(dir, 'b.txt', 'b\n')
    commitAll(dir, 'own')
    git(dir, ['checkout', '-q', 'main'])
    git(dir, ['cherry-pick', 'feature~1'])
    const { odb } = await loadRepository(dir)
    const outcome = merged(await mergeBranches(odb, { base: rev(dir, 'main'), head: rev(dir, 'feature'), method: 'rebase', message: '', committer: COMMITTER }))
    git(dir, ['checkout', '-q', '-B', 'probe', 'feature'])
    git(dir, ['rebase', '-q', '--force-rebase', 'main'])
    expect(outcome.commit).toBe(rev(dir, 'HEAD'))
    expect(outcome.rebased).toHaveLength(1)
  })

  it('reports conflicts where git reports conflicts', async () => {
    const dir = initRepo()
    writeFile(dir, 'a.txt', lines(10))
    writeFile(dir, 'gone.txt', 'gone\n')
    writeFile(dir, 'bin.dat', new Uint8Array([0, 1, 2]))
    writeFile(dir, 'mode.sh', 'echo\n')
    commitAll(dir, 'base')
    git(dir, ['checkout', '-q', '-b', 'feature'])
    writeFile(dir, 'a.txt', edit(lines(10), 4, 'feature'))
    writeFile(dir, 'gone.txt', 'changed\n')
    writeFile(dir, 'bin.dat', new Uint8Array([0, 1, 3]))
    chmodSync(join(dir, 'mode.sh'), 0o755)
    git(dir, ['update-index', '--chmod=+x', 'mode.sh'])
    commitAll(dir, 'feature')
    git(dir, ['checkout', '-q', 'main'])
    writeFile(dir, 'a.txt', edit(lines(10), 4, 'main'))
    rmSync(join(dir, 'gone.txt'))
    writeFile(dir, 'bin.dat', new Uint8Array([0, 1, 4]))
    commitAll(dir, 'main')
    const { odb } = await loadRepository(dir)
    const outcome = await mergeBranches(odb, { base: rev(dir, 'main'), head: rev(dir, 'feature'), method: 'merge', message: 'm', committer: COMMITTER })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok && outcome.reason === 'conflict') {
      expect(outcome.conflicts).toEqual([
        { path: 'a.txt', reason: 'content' },
        { path: 'bin.dat', reason: 'binary' },
        { path: 'gone.txt', reason: 'modify/delete' },
      ])
    } else throw new Error('expected a conflict')
    expect(gitMerge(dir, 'main', 'feature', 'm').clean).toBe(false)
    const check = await checkMergeability(odb, rev(dir, 'main'), rev(dir, 'feature'))
    expect(check).toMatchObject({ mergeable: false, rebaseable: false, upToDate: false, reason: 'conflict' })
    expect((await mergeBranches(odb, { base: rev(dir, 'main'), head: rev(dir, 'feature'), method: 'rebase', message: '', committer: COMMITTER })).ok).toBe(false)
  })

  it('refuses up-to-date and unrelated histories', async () => {
    const dir = divergent()
    git(dir, ['checkout', '-q', '--orphan', 'other'])
    git(dir, ['rm', '-rqf', '.'])
    writeFile(dir, 'x.txt', 'x\n')
    commitAll(dir, 'orphan')
    const { odb } = await loadRepository(dir)
    const main = rev(dir, 'main')
    expect(await mergeBranches(odb, { base: main, head: rev(dir, 'main~1'), method: 'merge', message: 'm', committer: COMMITTER })).toEqual({ ok: false, reason: 'up-to-date' })
    expect(await mergeBranches(odb, { base: main, head: rev(dir, 'other'), method: 'squash', message: 'm', committer: COMMITTER })).toEqual({ ok: false, reason: 'unrelated' })
    expect(await mergeBranches(odb, { base: main, head: rev(dir, 'other'), method: 'rebase', message: 'm', committer: COMMITTER })).toEqual({ ok: false, reason: 'unrelated' })
    expect((await checkMergeability(odb, main, rev(dir, 'other'))).reason).toBe('unrelated')
  })

  it('merges criss-cross histories through a virtual merge base like git', async () => {
    const dir = initRepo()
    writeFile(dir, 'a.txt', lines(40))
    commitAll(dir, 'base')
    git(dir, ['checkout', '-q', '-b', 'side'])
    writeFile(dir, 'a.txt', edit(lines(40), 5, 'side 1'))
    commitAll(dir, 'side 1')
    git(dir, ['checkout', '-q', 'main'])
    writeFile(dir, 'a.txt', edit(lines(40), 30, 'main 1'))
    commitAll(dir, 'main 1')
    git(dir, ['checkout', '-q', '-b', 'm1', 'main'])
    git(dir, ['merge', '-q', '--no-ff', '-m', 'm1', 'side'])
    git(dir, ['checkout', '-q', '-b', 's1', 'side'])
    git(dir, ['merge', '-q', '--no-ff', '-m', 's1', 'main'])
    writeFile(dir, 'b.txt', 'side only\n')
    commitAll(dir, 'side 2')
    git(dir, ['checkout', '-q', 'm1'])
    writeFile(dir, 'a.txt', edit(edit(lines(40), 5, 'side 1'), 30, 'main 1').replace('line 15\n', 'main 2\n'))
    commitAll(dir, 'main 2')
    const { odb } = await loadRepository(dir)
    expect(await mergeBases(odb, rev(dir, 'm1'), rev(dir, 's1'))).toHaveLength(2)
    const outcome = merged(await mergeBranches(odb, { base: rev(dir, 'm1'), head: rev(dir, 's1'), method: 'merge', message: 'cross', committer: COMMITTER }))
    const expected = gitMerge(dir, 'm1', 's1', 'cross')
    expect(expected.commit).toBe(outcome.commit)
  })

  it('lists the commits of a branch parents first', async () => {
    const dir = divergent()
    const { odb } = await loadRepository(dir)
    expect(await commitsBetween(odb, rev(dir, 'main'), rev(dir, 'feature'))).toEqual(git(dir, ['rev-list', '--reverse', '--topo-order', 'main..feature']).trim().split('\n'))
  })

  it('serializes commits byte-identical to git', async () => {
    const dir = divergent()
    const { odb } = await loadRepository(dir)
    for (const id of git(dir, ['rev-list', '--all']).trim().split('\n')) {
      const object = (await odb.read(id))!
      expect(serializeCommit(parseCommitDetails(object.data))).toEqual(object.data)
      expect(parseCommit(object.data).tree).toBe(rev(dir, `${id}^{tree}`))
    }
  })
})

const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

describe('randomized merges against git merge --no-ff', () => {
  it('agrees on clean/conflict and produces identical trees', async () => {
    const rand = random(42)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!
    const paths = ['a.txt', 'b.txt', 'd/c.txt', 'd/e/f.txt', 'g.txt', 'd/h.txt', 'x/y.txt']
    let clean = 0
    let conflicted = 0
    for (let round = 0; round < 40; round++) {
      const dir = initRepo()
      const content = new Map<string, string[]>()
      for (const path of paths.slice(0, 4)) {
        const body = Array.from({ length: 12 }, (_, i) => `${path} ${i}\n`)
        content.set(path, body)
        writeFile(dir, path, body.join(''))
      }
      commitAll(dir, 'base')
      const mutateBranch = (name: string) => {
        git(dir, ['checkout', '-q', '-B', name, 'main~0'])
        const state = new Map([...content].map(([path, body]) => [path, [...body]]))
        for (let step = 0; step < 1 + Math.floor(rand() * 4); step++) {
          const path = pick(paths)
          const body = state.get(path)
          const op = rand()
          if (!body) {
            const fresh = Array.from({ length: 3 }, (_, i) => `${name} ${path} ${i}\n`)
            state.set(path, fresh)
            writeFile(dir, path, fresh.join(''))
          } else if (op < 0.15) {
            state.delete(path)
            rmSync(join(dir, path))
          } else if (op < 0.25) {
            chmodSync(join(dir, path), 0o755)
          } else {
            const at = Math.floor(rand() * (body.length + 1))
            if (rand() < 0.5) body.splice(at, 1, `${name} edit ${step}\n`)
            else body.splice(at, 0, `${name} insert ${step}\n`)
            writeFile(dir, path, body.join(''))
          }
        }
        commitAll(dir, `${name} work`)
      }
      mutateBranch('ours')
      mutateBranch('theirs')
      git(dir, ['checkout', '-q', 'main'])
      const { odb } = await loadRepository(dir)
      const outcome = await mergeBranches(odb, { base: rev(dir, 'ours'), head: rev(dir, 'theirs'), method: 'merge', message: 'random', committer: COMMITTER })
      const expected = gitMerge(dir, 'ours', 'theirs', 'random')
      expect(outcome.ok, `round ${round}: ${JSON.stringify(outcome.ok ? null : outcome)}`).toBe(expected.clean)
      if (outcome.ok) {
        clean++
        expect(outcome.commit, `round ${round}`).toBe(expected.commit)
      } else conflicted++
    }
    expect(clean).toBeGreaterThan(5)
    expect(conflicted).toBeGreaterThan(5)
  }, 120_000)
})
