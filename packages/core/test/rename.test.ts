import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeBranches, type MergeOutcome } from '../src/merge.ts'
import { parseSignature } from '../src/objects.ts'
import { DEFAULT_RENAME_SCORE, estimateSimilarity, MAX_SCORE, spanHashes } from '../src/rename.ts'
import { commitAll, git, gitEnv, initRepo, writeFile } from './git-helpers.ts'
import { loadRepository } from './repo-helpers.ts'

const COMMITTER = parseSignature(`${gitEnv.GIT_COMMITTER_NAME} <${gitEnv.GIT_COMMITTER_EMAIL}> ${Date.parse(gitEnv.GIT_COMMITTER_DATE) / 1000} +0000`)!

const rev = (dir: string, ref: string) => git(dir, ['rev-parse', ref]).trim()

const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

const encoder = new TextEncoder()

const gitMerge = (dir: string, base: string, head: string, message: string): { clean: boolean; commit: string | null } => {
  git(dir, ['checkout', '-q', '-B', 'probe', base])
  const result = spawnSync('git', ['-c', 'merge.renames=true', 'merge', '--no-ff', '-q', '-m', message, head], { cwd: dir, env: { ...process.env, ...gitEnv }, encoding: 'utf8' })
  if (result.status !== 0) {
    git(dir, ['merge', '--abort'])
    return { clean: false, commit: null }
  }
  return { clean: true, commit: rev(dir, 'HEAD') }
}

const describeOutcome = (outcome: MergeOutcome) => (outcome.ok ? 'clean' : JSON.stringify(outcome))

describe('rename similarity', () => {
  it('scores like git diff -M for edited, shortened, CRLF and binary files', () => {
    const rand = random(7)
    const dir = initRepo()
    const cases: [Uint8Array, Uint8Array][] = []
    for (let i = 0; i < 60; i++) {
      const count = 5 + Math.floor(rand() * 60)
      const original = Array.from({ length: count }, (_, n) => `${'x'.repeat(Math.floor(rand() * 90))} line ${n} of case ${i}\n`)
      const changed = original.filter(() => rand() > 0.25).map((line) => (rand() < 0.2 ? `${line.trim()} edited\n` : line))
      if (rand() < 0.3) changed.push(`appended ${i}\n`)
      let before = original.join('')
      let after = changed.join('')
      if (i % 7 === 0) after = after.replaceAll('\n', '\r\n')
      if (i % 11 === 0) after = after.slice(0, -1)
      cases.push([encoder.encode(before), i % 13 === 0 ? new Uint8Array([0, ...encoder.encode(after)]) : encoder.encode(after)])
      before = ''
    }
    cases.forEach(([before], i) => writeFile(dir, `case-${i}/old.txt`, before))
    commitAll(dir, 'before')
    cases.forEach(([, after], i) => {
      rmSync(join(dir, `case-${i}/old.txt`))
      writeFile(dir, `case-${i}/new.txt`, after)
    })
    commitAll(dir, 'after')
    const output = git(dir, ['diff', '-M1%', '--name-status', 'HEAD~', 'HEAD'])
    const reported = new Map(
      output
        .trim()
        .split('\n')
        .filter((line) => line.startsWith('R'))
        .map((line) => {
          const [status, from] = line.split('\t') as [string, string]
          return [from.split('/')[0]!, Number(status.slice(1))]
        }),
    )
    cases.forEach(([before, after], i) => {
      const score = estimateSimilarity(spanHashes(before), spanHashes(after), MAX_SCORE / 100)
      const expected = reported.get(`case-${i}`)
      if (expected === undefined) expect(score, `case ${i}`).toBeLessThan(MAX_SCORE / 100)
      else expect(Math.floor((score * 100) / MAX_SCORE), `case ${i}`).toBe(expected)
    })
    console.log(JSON.stringify({ renamed: reported.size }))
    expect(DEFAULT_RENAME_SCORE).toBe(MAX_SCORE / 2)
  })
})

const base = (dir: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content)
  commitAll(dir, 'base')
}

const branch = (dir: string, name: string, from: string, change: () => void) => {
  git(dir, ['checkout', '-q', '-B', name, from])
  change()
  commitAll(dir, name)
}

const body = (tag: string, count = 20) => Array.from({ length: count }, (_, i) => `${tag} line ${i}\n`).join('')

const edit = (text: string, index: number, replacement: string) => {
  const parts = text.split('\n')
  parts[index] = replacement
  return parts.join('\n')
}

const mergeBoth = async (dir: string) => {
  const { odb } = await loadRepository(dir)
  const outcome = await mergeBranches(odb, { base: rev(dir, 'ours'), head: rev(dir, 'theirs'), method: 'merge', message: 'm', committer: COMMITTER })
  const expected = gitMerge(dir, 'ours', 'theirs', 'm')
  return { outcome, expected }
}

describe('rename-aware merges against git merge', () => {
  it('merges an edit into a renamed file', async () => {
    const dir = initRepo()
    base(dir, { 'src/app.ts': body('app'), 'README.md': body('readme') })
    branch(dir, 'ours', 'main', () => {
      rmSync(join(dir, 'src/app.ts'))
      writeFile(dir, 'lib/application.ts', edit(body('app'), 1, 'renamed and edited'))
    })
    branch(dir, 'theirs', 'main', () => writeFile(dir, 'src/app.ts', edit(body('app'), 15, 'their edit')))
    const { outcome, expected } = await mergeBoth(dir)
    expect(expected.clean).toBe(true)
    expect(outcome.ok, describeOutcome(outcome)).toBe(true)
    if (outcome.ok) expect(outcome.commit).toBe(expected.commit)
    const { odb } = await loadRepository(dir)
    const rebased = await mergeBranches(odb, { base: rev(dir, 'theirs'), head: rev(dir, 'ours'), method: 'rebase', message: '', committer: COMMITTER })
    git(dir, ['checkout', '-q', '-B', 'probe', 'ours'])
    git(dir, ['rebase', '-q', '--force-rebase', 'theirs'])
    expect(rebased.ok && rebased.commit).toBe(rev(dir, 'HEAD'))
    const squashed = await mergeBranches(odb, { base: rev(dir, 'ours'), head: rev(dir, 'theirs'), method: 'squash', message: 's', committer: COMMITTER })
    git(dir, ['checkout', '-q', '-B', 'probe', 'ours'])
    git(dir, ['merge', '--squash', '-q', 'theirs'], { stdio: ['pipe', 'pipe', 'ignore'] })
    expect(squashed.ok && squashed.tree).toBe(git(dir, ['write-tree']).trim())
  })

  it('merges both sides renaming to the same path and edits on the other side of a basename move', async () => {
    const dir = initRepo()
    base(dir, { 'a/one.txt': body('one'), 'a/two.txt': body('two'), 'keep.txt': body('keep') })
    branch(dir, 'ours', 'main', () => {
      rmSync(join(dir, 'a/one.txt'))
      writeFile(dir, 'b/uno.txt', edit(body('one'), 2, 'ours'))
      rmSync(join(dir, 'a/two.txt'))
      writeFile(dir, 'c/two.txt', body('two'))
    })
    branch(dir, 'theirs', 'main', () => {
      rmSync(join(dir, 'a/one.txt'))
      writeFile(dir, 'b/uno.txt', edit(body('one'), 18, 'theirs'))
      writeFile(dir, 'a/two.txt', edit(body('two'), 10, 'theirs edit'))
      writeFile(dir, 'a/three.txt', body('three'))
    })
    const { outcome, expected } = await mergeBoth(dir)
    expect(outcome.ok).toBe(false)
    expect(expected.clean).toBe(false)
  })

  it('reports rename/delete and rename/rename conflicts like git', async () => {
    const dir = initRepo()
    base(dir, { 'x.txt': body('x'), 'y.txt': body('y') })
    branch(dir, 'ours', 'main', () => {
      rmSync(join(dir, 'x.txt'))
      writeFile(dir, 'x-moved.txt', body('x'))
      rmSync(join(dir, 'y.txt'))
      writeFile(dir, 'y-ours.txt', body('y'))
    })
    branch(dir, 'theirs', 'main', () => {
      rmSync(join(dir, 'x.txt'))
      rmSync(join(dir, 'y.txt'))
      writeFile(dir, 'y-theirs.txt', body('y'))
    })
    const { outcome, expected } = await mergeBoth(dir)
    expect(expected.clean).toBe(false)
    expect(outcome.ok ? [] : outcome.reason === 'conflict' ? outcome.conflicts : []).toEqual([
      { path: 'x.txt', reason: 'rename' },
      { path: 'y.txt', reason: 'rename' },
    ])
  })

  it('adds into a deleted directory cleanly and reports adds into a renamed directory like git', async () => {
    const deleted = initRepo()
    base(deleted, { 'old/a.txt': body('a'), 'old/b.txt': body('b'), 'keep.txt': body('keep') })
    branch(deleted, 'ours', 'main', () => rmSync(join(deleted, 'old'), { recursive: true }))
    branch(deleted, 'theirs', 'main', () => writeFile(deleted, 'old/c.txt', body('c')))
    const clean = await mergeBoth(deleted)
    expect(clean.expected.clean).toBe(true)
    expect(clean.outcome.ok && clean.outcome.commit).toBe(clean.expected.commit)
    const renamed = initRepo()
    base(renamed, { 'old/a.txt': body('a'), 'old/b.txt': body('b'), 'keep.txt': body('keep') })
    branch(renamed, 'ours', 'main', () => git(renamed, ['mv', 'old', 'new']))
    branch(renamed, 'theirs', 'main', () => writeFile(renamed, 'old/c.txt', body('c')))
    const moved = await mergeBoth(renamed)
    expect(moved.expected.clean).toBe(false)
    expect(moved.outcome.ok ? [] : moved.outcome.reason === 'conflict' ? moved.outcome.conflicts : []).toEqual([{ path: 'old/c.txt', reason: 'directory-rename' }])
  })

  it('agrees with git on randomized histories with renames, moves and edits', async () => {
    const rand = random(1234)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!
    const directories = ['', 'src/', 'lib/', 'docs/', 'src/deep/']
    let clean = 0
    let conflicted = 0
    let conservative = 0
    for (let round = 0; round < 60; round++) {
      const dir = initRepo()
      const files = new Map<string, string[]>()
      for (let i = 0; i < 6; i++) {
        const path = `${pick(directories)}file-${i}.txt`
        if (files.has(path)) continue
        files.set(path, Array.from({ length: 10 + Math.floor(rand() * 20) }, (_, n) => `${path} ${n} ${'y'.repeat(Math.floor(rand() * 30))}\n`))
      }
      base(dir, Object.fromEntries([...files].map(([path, lines]) => [path, lines.join('')])))
      const mutate = (name: string) =>
        branch(dir, name, 'main', () => {
          const state = new Map([...files].map(([path, lines]) => [path, [...lines]]))
          for (let step = 0; step < 1 + Math.floor(rand() * 4); step++) {
            const [path, lines] = pick([...state])
            const op = rand()
            if (op < 0.4) {
              const target = rand() < 0.5 ? `${pick(directories)}${path.split('/').pop()}` : `${pick(directories)}renamed-${name}-${step}.txt`
              if (state.has(target)) continue
              if (rand() < 0.6) lines.splice(Math.floor(rand() * lines.length), 1, `${name} moved ${step}\n`)
              state.delete(path)
              state.set(target, lines)
              rmSync(join(dir, path))
              writeFile(dir, target, lines.join(''))
            } else if (op < 0.5) {
              state.delete(path)
              rmSync(join(dir, path))
            } else if (op < 0.6) {
              const fresh = `${pick(directories)}new-${name}-${step}.txt`
              if (state.has(fresh)) continue
              state.set(fresh, [`${name} ${step}\n`])
              writeFile(dir, fresh, `${name} ${step}\n`)
            } else {
              const at = Math.floor(rand() * lines.length)
              lines.splice(at, rand() < 0.5 ? 1 : 0, `${name} edit ${step}\n`)
              writeFile(dir, path, lines.join(''))
            }
          }
        })
      mutate('ours')
      mutate('theirs')
      git(dir, ['checkout', '-q', 'main'])
      const { outcome, expected } = await mergeBoth(dir)
      if (outcome.ok) {
        expect(expected.clean, `round ${round}: we merged cleanly, git did not`).toBe(true)
        expect(outcome.commit, `round ${round}`).toBe(expected.commit)
        clean++
      } else if (expected.clean) {
        conservative++
      } else conflicted++
    }
    console.log(JSON.stringify({ clean, conflicted, conservative }))
    expect(clean).toBeGreaterThan(15)
    expect(conflicted).toBeGreaterThan(5)
    expect(conservative).toBeLessThanOrEqual(clean / 5)
  }, 180_000)
})
