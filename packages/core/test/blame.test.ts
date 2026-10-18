import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blame } from '../src/blame.ts'
import { ObjectDatabase } from '../src/repository.ts'
import { commitAll, git, gitEnv, initRepo, writeFile } from './git-helpers.ts'
import { type Forge, startForge } from './mirror-helpers.ts'

const repo = { owner: 'acme', name: 'blame' }

let forge: Forge
let dir: string
let head: string
let odb: ObjectDatabase

const lines = (...values: string[]) => `${values.join('\n')}\n`

beforeAll(async () => {
  forge = await startForge()
  const url = await forge.createRepo(repo)
  dir = initRepo()
  writeFile(dir, 'f.txt', lines('a', 'b', 'c', 'd', 'e', 'f'))
  commitAll(dir, 'one')
  writeFile(dir, 'f.txt', lines('a', 'b', 'C', 'd', 'e', 'f'))
  commitAll(dir, 'two')
  git(dir, ['checkout', '-q', '-b', 'side'])
  writeFile(dir, 'f.txt', lines('a', 'b', 'C', 'd', 'E', 'f', 'side'))
  commitAll(dir, 'side')
  git(dir, ['checkout', '-q', 'main'])
  writeFile(dir, 'f.txt', lines('A', 'b', 'C', 'd', 'e', 'f'))
  commitAll(dir, 'three')
  git(dir, ['merge', '-q', '--no-edit', 'side'])
  writeFile(dir, 'f.txt', lines('A', 'b', 'C', 'inserted', 'd', 'E', 'f', 'side'))
  head = commitAll(dir, 'four')
  await promisify(execFile)('git', ['push', '-q', url, 'main'], { cwd: dir, env: { ...process.env, ...gitEnv } })
  odb = new ObjectDatabase(forge.storage, repo)
}, 60_000)

afterAll(async () => {
  await forge.server.close()
})

const gitBlame = (): string[] =>
  git(dir, ['blame', '--porcelain', 'main', '--', 'f.txt'])
    .split('\n')
    .filter((line) => /^[0-9a-f]{40} \d+ \d+/.test(line))
    .map((line) => line.split(' ')[0]!)

describe('blame', () => {
  it('attributes every line like git blame, across a merge', async () => {
    const result = (await blame(odb, head, ['f.txt']))!
    expect(result.complete).toBe(true)
    const ours = result.ranges.flatMap((range) => Array.from({ length: range.count }, () => range.commit!.id))
    expect(ours).toEqual(gitBlame())
    expect(result.lines).toBe(8)
  })

  it('stops after the commit budget and leaves older lines unattributed', async () => {
    const result = (await blame(odb, head, ['f.txt'], 1))!
    expect(result.complete).toBe(false)
    expect(result.walked).toBe(1)
    expect(result.ranges.filter((range) => range.commit?.id === head).map((range) => range.start)).toEqual([4])
    expect(result.ranges.some((range) => range.commit === null)).toBe(true)
  })

  it('returns null for missing paths and directories', async () => {
    expect(await blame(odb, head, ['missing.txt'])).toBeNull()
    expect(await blame(odb, head, [])).toBeNull()
  })
})
