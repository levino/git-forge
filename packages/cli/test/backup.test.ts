import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { backupRepository, nameKeyFromSecret, parseRecoveryPublicKey } from '@git-forge/backup'
import { lfsObjectKey, MemoryStorage } from '@git-forge/core'
import { commitAll, git, initRepo, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { loadRepository } from '@git-forge/core/test/repo-helpers.ts'
import { FsStorage } from '@git-forge/node'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

const main = resolve(import.meta.dirname, '../src/main.ts')

const cli = (args: readonly string[]) => run(process.execPath, ['--experimental-transform-types', '--no-warnings', main, ...args], { env: { ...process.env, HOME: tempDir() } })

const lfsRepository = () => {
  const dir = initRepo()
  git(dir, ['lfs', 'install', '--local'])
  git(dir, ['lfs', 'track', '*.bin'])
  writeFile(dir, 'README.md', '# site\n')
  writeFile(dir, 'media/photo.bin', new Uint8Array(Array.from({ length: 5000 }, (_, i) => (i * 7) % 251)))
  commitAll(dir, 'add media')
  const oid = git(dir, ['lfs', 'ls-files', '--long']).trim().split(' ')[0] as string
  return { dir, oid }
}

describe('git forge backup', () => {
  it('generates a key, lists, checks and restores a repository with LFS objects', async () => {
    const work = tempDir()
    const keyFile = join(work, 'recovery.jwk')
    const generated = await cli(['backup', 'keygen', keyFile])
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(generated.stderr).toContain('keep it offline')
    const publicKey = parseRecoveryPublicKey(generated.stdout.trim())
    await expect(cli(['backup', 'keygen', keyFile])).rejects.toThrow(/exists/)

    const { dir, oid } = lfsRepository()
    const repo = { owner: 'acme', name: 'site' }
    const { storage } = await loadRepository(dir, repo, new MemoryStorage())
    const media = readFileSync(join(dir, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid))
    await storage.put(lfsObjectKey(repo, oid), new Uint8Array(media), media.length)
    const bucket = join(work, 'bucket')
    await backupRepository({ source: storage, repository: repo, storage: new FsStorage(bucket), recipient: publicKey, names: await nameKeyFromSecret('s'.repeat(40)) })

    const listed = await cli(['backup', 'list', '--from', bucket, '--key', keyFile])
    expect(listed.stdout).toMatch(/^snapshots\/\S+\t\S+\tacme\/site\trefs=1 packs=1 lfs=1\n$/)
    const checked = await cli(['backup', 'check', '--from', bucket])
    expect(checked.stdout).toMatch(/^3 objects, 1 snapshots, 1 runs/)

    const copy = join(work, 'copy')
    expect((await cli(['backup', 'copy', '--from', bucket, '--to', copy])).stdout).toMatch(/^copied \d+ objects/)

    const restored = join(work, 'restored.git')
    const result = await cli(['backup', 'restore', '--from', copy, '--key', keyFile, 'acme/site', restored])
    expect(result.stderr).toContain('1 packs, 1 LFS objects')
    git(restored, ['fsck', '--strict', '--no-dangling'])
    expect(git(restored, ['lfs', 'fsck'])).toContain('Git LFS fsck OK')
    const clone = join(work, 'clone')
    git(work, ['clone', '-q', restored, clone])
    expect(git(clone, ['rev-parse', 'HEAD']).trim()).toBe(git(dir, ['rev-parse', 'HEAD']).trim())
    expect(existsSync(join(restored, 'git-forge-data.json'))).toBe(false)

    await expect(cli(['backup', 'restore', '--from', copy, '--key', keyFile, 'acme/site', restored])).rejects.toThrow(/not empty/)
    expect(readdirSync(join(restored, 'objects', 'pack')).length).toBe(2)
  })
})
