import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { utf8 } from '../src/bytes.ts'
import { storeObjects } from '../src/commit.ts'
import { commitFileChanges, EditError, isLfsTracked, lfsPointerText, mergeConflictFiles, resolveMergeConflicts } from '../src/edit.ts'
import { handleGitRequest } from '../src/http.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { parseSignature } from '../src/objects.ts'
import { updateRefs } from '../src/ref-update.ts'
import { ObjectDatabase } from '../src/repository.ts'
import { commitAll, git, gitEnv, initRepo, tempDir, writeFile } from './git-helpers.ts'
import { type RunningServer, startServer } from './http-server.ts'
import { loadRepository } from './repo-helpers.ts'

const SIGNATURE = parseSignature('Web Editor <web@example.org> 1767225600 +0000')!

let storage: MemoryStorage
let server: RunningServer

beforeAll(async () => {
  server = await startServer(async (request) => (await handleGitRequest(request, { storage })) ?? new Response('not found', { status: 404 }))
})

afterAll(async () => {
  await server.close()
})

const rev = (dir: string, ref: string) => git(dir, ['rev-parse', ref]).trim()

const cloneAndCheck = async (branch: string) => {
  const clone = join(tempDir(), 'clone')
  await promisify(execFile)('git', ['clone', '-q', '-b', branch, `${server.url}/acme/site.git`, clone], { env: { ...process.env, ...gitEnv } })
  git(clone, ['fsck', '--strict', '--no-dangling'])
  return clone
}

describe('commits built from file changes', () => {
  it('writes the same tree as git and clones cleanly', async () => {
    const dir = initRepo()
    writeFile(dir, 'README.md', 'hello\n')
    writeFile(dir, 'docs/a.txt', 'a\n')
    writeFile(dir, 'docs/old.txt', 'old\n')
    writeFile(dir, 'run.sh', '#!/bin/sh\n')
    chmodSync(join(dir, 'run.sh'), 0o755)
    const base = commitAll(dir, 'base')
    ;({ storage } = await loadRepository(dir))
    const repo = { owner: 'acme', name: 'site' }
    const database = new ObjectDatabase(storage, repo)
    const built = await commitFileChanges(database, {
      parent: base,
      changes: [
        { path: 'README.md', content: utf8('hello web\n') },
        { path: 'docs/old.txt', content: null },
        { path: 'docs/new/deep.txt', content: utf8('deep\n') },
        { path: 'run.sh', content: utf8('#!/bin/sh\necho hi\n') },
      ],
      message: 'Edit in the browser',
      author: SIGNATURE,
      committer: SIGNATURE,
    })
    writeFile(dir, 'README.md', 'hello web\n')
    rmSync(join(dir, 'docs/old.txt'))
    writeFile(dir, 'docs/new/deep.txt', 'deep\n')
    writeFile(dir, 'run.sh', '#!/bin/sh\necho hi\n')
    git(dir, ['add', '-A'])
    expect(built.tree).toBe(git(dir, ['write-tree']).trim())
    await storeObjects(database, built.objects)
    expect((await updateRefs(storage, repo, [{ name: 'refs/heads/main', oldId: base, newId: built.commit }])).ok).toBe(true)
    const clone = await cloneAndCheck('main')
    expect(rev(clone, 'HEAD')).toBe(built.commit)
    expect(git(clone, ['diff', '--name-status', 'HEAD~1', 'HEAD']).trim().split('\n')).toEqual(['M\tREADME.md', 'A\tdocs/new/deep.txt', 'D\tdocs/old.txt', 'M\trun.sh'])
    expect(git(clone, ['log', '-1', '--format=%an <%ae>%n%s'])).toBe('Web Editor <web@example.org>\nEdit in the browser\n')
    expect(git(clone, ['ls-files', '-s', 'run.sh'])).toMatch(/^100755 /)
  })

  it('refuses invalid paths, missing files and empty commits', async () => {
    const dir = initRepo()
    writeFile(dir, 'a/b.txt', 'b\n')
    const base = commitAll(dir, 'base')
    const { odb } = await loadRepository(dir)
    const attempt = (changes: Parameters<typeof commitFileChanges>[1]['changes']) => commitFileChanges(odb, { parent: base, changes, message: 'x', author: SIGNATURE, committer: SIGNATURE })
    await expect(attempt([{ path: '../x', content: utf8('x') }])).rejects.toThrow(EditError)
    await expect(attempt([{ path: '.git/config', content: utf8('x') }])).rejects.toThrow(EditError)
    await expect(attempt([{ path: 'missing.txt', content: null }])).rejects.toThrow(/does not exist/)
    await expect(attempt([{ path: 'a', content: utf8('x') }])).rejects.toThrow(/is a directory/)
    await expect(attempt([{ path: 'a/b.txt/c', content: utf8('x') }])).rejects.toThrow(/is a file/)
    await expect(attempt([{ path: 'a/b.txt', content: utf8('b\n') }])).rejects.toThrow(/no changes/)
  })

  it('decides LFS tracking like git check-attr', async () => {
    const dir = initRepo()
    writeFile(dir, '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\nassets/** filter=lfs\n/top.dat filter=lfs\nkeep.bin -filter\n')
    writeFile(dir, 'sub/.gitattributes', '*.txt filter=lfs\nplain.bin !filter\n')
    writeFile(dir, 'x', 'x\n')
    const base = commitAll(dir, 'base')
    const { odb } = await loadRepository(dir)
    const paths = ['a.bin', 'deep/a.bin', 'assets/x/y.png', 'other/assets/y.png', 'top.dat', 'deep/top.dat', 'keep.bin', 'sub/a.txt', 'a.txt', 'sub/plain.bin', 'sub/deeper/b.txt']
    for (const path of paths) {
      const expected = git(dir, ['check-attr', 'filter', '--', path]).trim().endsWith(': lfs')
      expect([path, await isLfsTracked(odb, base, path)]).toEqual([path, expected])
    }
    expect(new TextDecoder().decode(lfsPointerText({ oid: 'a'.repeat(64), size: 3 }))).toBe(`version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 3\n`)
  })
})

const conflicted = () => {
  const dir = initRepo()
  writeFile(dir, 'a.txt', 'one\ntwo\nthree\nfour\nfive\n')
  writeFile(dir, 'b.bin', new Uint8Array([0, 1, 2]))
  writeFile(dir, 'same.txt', 'same\n')
  commitAll(dir, 'base')
  git(dir, ['checkout', '-q', '-b', 'feature'])
  writeFile(dir, 'a.txt', 'one\nTWO feature\nthree\nfour\nfive feature\n')
  commitAll(dir, 'feature')
  git(dir, ['checkout', '-q', 'main'])
  writeFile(dir, 'a.txt', 'one\nTWO main\nthree\nfour\nfive\nsix\n')
  commitAll(dir, 'main')
  return dir
}

describe('conflict resolution', () => {
  it('shows the conflict markers git writes and commits a resolution git accepts', async () => {
    const dir = conflicted()
    ;({ storage } = await loadRepository(dir))
    const odb = new ObjectDatabase(storage, { owner: 'acme', name: 'site' })
    const head = rev(dir, 'feature')
    const base = rev(dir, 'main')
    const files = await mergeConflictFiles(odb, head, base, ['HEAD', 'main'])
    git(dir, ['checkout', '-q', 'feature'])
    expect(spawnSync('git', ['merge', '-q', 'main'], { cwd: dir, env: { ...process.env, ...gitEnv } }).status).not.toBe(0)
    expect(files).toEqual([{ path: 'a.txt', reason: 'content', text: readFileSync(join(dir, 'a.txt'), 'utf8') }])
    git(dir, ['merge', '--abort'])
    const resolved = 'one\nTWO both\nthree\nfour\nfive feature\nsix\n'
    await expect(resolveMergeConflicts(odb, { ours: head, theirs: base, resolutions: new Map([['a.txt', files![0]!.text!]]), message: 'm', author: SIGNATURE, committer: SIGNATURE })).rejects.toThrow(/conflict markers/)
    const built = await resolveMergeConflicts(odb, { ours: head, theirs: base, resolutions: new Map([['a.txt', resolved]]), message: "Merge branch 'main' into feature", author: SIGNATURE, committer: SIGNATURE })
    await storeObjects(odb, built.objects)
    expect((await updateRefs(storage, { owner: 'acme', name: 'site' }, [{ name: 'refs/heads/feature', oldId: head, newId: built.commit }])).ok).toBe(true)
    const clone = await cloneAndCheck('feature')
    expect(git(clone, ['log', '-1', '--format=%P']).trim()).toBe(`${head} ${base}`)
    expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe(resolved)
    expect(git(clone, ['diff', '--name-only', 'origin/main', 'HEAD']).trim()).toBe('a.txt')
    expect(spawnSync('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], { cwd: clone }).status).toBe(0)
  })

  it('refuses binary and LFS conflicts', async () => {
    const dir = initRepo()
    writeFile(dir, 'b.bin', new Uint8Array([0, 1, 2]))
    writeFile(dir, 'big.psd', `version https://git-lfs.github.com/spec/v1\noid sha256:${'1'.repeat(64)}\nsize 1\n`)
    commitAll(dir, 'base')
    git(dir, ['checkout', '-q', '-b', 'feature'])
    writeFile(dir, 'b.bin', new Uint8Array([0, 1, 3]))
    writeFile(dir, 'big.psd', `version https://git-lfs.github.com/spec/v1\noid sha256:${'2'.repeat(64)}\nsize 2\n`)
    commitAll(dir, 'feature')
    git(dir, ['checkout', '-q', 'main'])
    writeFile(dir, 'b.bin', new Uint8Array([0, 1, 4]))
    writeFile(dir, 'big.psd', `version https://git-lfs.github.com/spec/v1\noid sha256:${'3'.repeat(64)}\nsize 3\n`)
    commitAll(dir, 'main')
    const { odb } = await loadRepository(dir)
    const files = await mergeConflictFiles(odb, rev(dir, 'feature'), rev(dir, 'main'), ['HEAD', 'main'])
    expect(files).toEqual([
      { path: 'b.bin', reason: 'binary', text: null },
      { path: 'big.psd', reason: 'content', text: null },
    ])
    await expect(resolveMergeConflicts(odb, { ours: rev(dir, 'feature'), theirs: rev(dir, 'main'), resolutions: new Map(), message: 'm', author: SIGNATURE, committer: SIGNATURE })).rejects.toThrow(/resolve them with git/)
  })
})
