import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  hashObject,
  lfsObjectKey,
  MemoryStorage,
  ObjectDatabase,
  readAll,
  readRefs,
  type RepositoryName,
  sha256Hex,
  streamOf,
  utf8,
  updateRefs,
} from '@git-forge/core'
import { commitAll, git, gitBytes, initRepo, sampleHistory, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { loadRepository } from '@git-forge/core/test/repo-helpers.ts'
import { describe, expect, it } from 'vitest'
import { backupRepositories, backupRepository } from '../src/backup.ts'
import { bareRepositoryFiles } from '../src/bare.ts'
import { generateRecoveryKey, nameKeyFromSecret } from '../src/keys.ts'
import { objectKey, SNAPSHOTS_PREFIX } from '../src/layout.ts'
import { checkBackupStructure, replicateBackup } from '../src/replicate.ts'
import { BackupNotFoundError, findSnapshot, restoreRepository, restoreSnapshot, runKeys, summarizeSnapshots } from '../src/restore.ts'

const repo: RepositoryName = { owner: 'acme', name: 'site' }
const SECRET = 'a backup naming secret that is long enough'
const MARKER = 'confidential-marker-7f3a'

const addLfsObject = async (storage: MemoryStorage, content: string) => {
  const bytes = utf8(content)
  const oid = sha256Hex(bytes)
  await storage.put(lfsObjectKey(repo, oid), bytes, bytes.length)
  return oid
}

const fixture = async () => {
  const dir = initRepo()
  sampleHistory(dir, 3)
  writeFile(dir, 'secret.txt', `${MARKER}\n`)
  commitAll(dir, 'add secret')
  git(dir, ['tag', '-a', 'v1', '-m', 'release v1'])
  const { storage } = await loadRepository(dir, repo)
  const oid = await addLfsObject(storage, `media ${MARKER}`)
  const recovery = await generateRecoveryKey()
  const target = new MemoryStorage()
  const names = await nameKeyFromSecret(SECRET)
  return { dir, storage, oid, recovery, target, names }
}

const allBytes = async (storage: MemoryStorage): Promise<string> => {
  const parts: string[] = []
  for await (const info of storage.list('')) {
    const object = await storage.get(info.key)
    parts.push(info.key, Buffer.from(await readAll(object!.body)).toString('latin1'))
  }
  return parts.join('\n')
}

const countKeys = async (storage: MemoryStorage) => {
  let count = 0
  for await (const _ of storage.list('')) count++
  return count
}

const pushCommit = async (dir: string, storage: MemoryStorage, message: string) => {
  writeFile(dir, `${message}.txt`, `${message}\n`)
  const previous = git(dir, ['rev-parse', 'HEAD']).trim()
  const id = commitAll(dir, message)
  const odb = new ObjectDatabase(storage, repo)
  await odb.ingest(streamOf(gitBytes(dir, ['pack-objects', '--stdout', '--revs', '--thin'], `${id}\n^${previous}\n`)))
  const result = await updateRefs(storage, repo, [{ name: 'refs/heads/main', oldId: previous, newId: id }], new ObjectDatabase(storage, repo))
  expect(result.ok).toBe(true)
  return id
}

describe('encrypted backups', () => {
  it('stores nothing readable and restores an identical repository', async () => {
    const { storage, recovery, target, names, oid } = await fixture()
    const result = await backupRepository({ source: storage, repository: repo, storage: target, recipient: recovery.publicKey, names, instance: 'https://alpha.example' })
    expect(result.unchanged).toBe(false)
    expect(result.uploaded).toBe(3)
    const everything = await allBytes(target)
    expect(everything).not.toContain(MARKER)
    expect(everything).not.toContain(oid)
    expect(everything).not.toContain('acme')
    expect(everything).not.toContain('refs/heads')

    const destination = new MemoryStorage()
    const restored = await restoreRepository({ backup: target, privateKey: recovery.privateKey, repository: repo, destination })
    expect(restored.snapshot).toBe(result.snapshot)
    expect((await readRefs(destination, repo))!.state).toEqual((await readRefs(storage, repo))!.state)
    const media = await destination.get(lfsObjectKey(repo, oid))
    expect(new TextDecoder().decode(await readAll(media!.body))).toBe(`media ${MARKER}`)
    const odb = new ObjectDatabase(destination, repo)
    const head = (await readRefs(destination, repo))!.state.refs['refs/heads/main']!
    expect((await odb.read(head))?.type).toBe('commit')
    expect((await destination.get('repos/acme/site/git/info/refs'))).not.toBeNull()
  })

  it('is incremental by content address and skips unchanged snapshots', async () => {
    const { dir, storage, recovery, target, names } = await fixture()
    const first = await backupRepository({ source: storage, repository: repo, storage: target, recipient: recovery.publicKey, names })
    const keysAfterFirst = (await countKeys(target))
    const second = await backupRepository({ source: storage, repository: repo, storage: target, recipient: recovery.publicKey, names })
    expect(second).toMatchObject({ unchanged: true, uploaded: 0, run: null, snapshot: null, present: first.uploaded })
    expect((await countKeys(target))).toBe(keysAfterFirst)

    const id = await pushCommit(dir, storage, 'next')
    await addLfsObject(storage, 'another object')
    const third = await backupRepository({ source: storage, repository: repo, storage: target, recipient: recovery.publicKey, names })
    expect(third).toMatchObject({ unchanged: false, uploaded: 3, present: 3 })

    const keys = runKeys(target, recovery.privateKey)
    const summaries = await summarizeSnapshots(target, keys)
    expect(summaries.map((summary) => summary.key)).toEqual([third.snapshot, first.snapshot])
    expect(summaries[0]).toMatchObject({ repository: 'acme/site', packs: 2, lfs: 2 })

    const latest = new MemoryStorage()
    await restoreRepository({ backup: target, privateKey: recovery.privateKey, repository: repo, destination: latest })
    expect((await readRefs(latest, repo))!.state.refs['refs/heads/main']).toBe(id)
    const older = new MemoryStorage()
    await restoreRepository({ backup: target, privateKey: recovery.privateKey, repository: repo, destination: older, snapshot: first.snapshot! })
    expect((await readRefs(older, repo))!.state.refs['refs/heads/main']).not.toBe(id)
  })

  it('shares objects between repositories and runs', async () => {
    const { storage, recovery, target, names } = await fixture()
    const copy: RepositoryName = { owner: 'acme', name: 'copy' }
    const { storage: second } = await loadRepository(initRepo(), copy, storage)
    expect(second).toBe(storage)
    const results = await backupRepositories({ source: storage, repositories: [repo, copy], storage: target, recipient: recovery.publicKey, names })
    expect(results.map((result) => result.unchanged)).toEqual([false, false])
    const keys = runKeys(target, recovery.privateKey)
    expect((await findSnapshot(target, keys, copy)).snapshot.repository.packs).toEqual([])
    await expect(findSnapshot(target, keys, { owner: 'acme', name: 'missing' })).rejects.toBeInstanceOf(BackupNotFoundError)
  })

  it('needs the recovery key to restore and detects swapped objects', async () => {
    const { storage, recovery, target, names } = await fixture()
    await backupRepository({ source: storage, repository: repo, storage: target, recipient: recovery.publicKey, names })
    const stranger = await generateRecoveryKey()
    await expect(restoreRepository({ backup: target, privateKey: stranger.privateKey, repository: repo, destination: new MemoryStorage() })).rejects.toThrow(/another recovery key/)

    const keys = runKeys(target, recovery.privateKey)
    const { snapshot } = await findSnapshot(target, keys, repo)
    const pack = snapshot.repository.packs[0]!
    const lfs = snapshot.repository.lfs[0]!
    const tampered = new MemoryStorage()
    for await (const info of target.list('')) {
      const object = await target.get(info.key)
      const bytes = await readAll(object!.body)
      const key = info.key === objectKey(pack.object) ? objectKey(lfs.object) : info.key === objectKey(lfs.object) ? objectKey(pack.object) : info.key
      await tampered.put(key, bytes, bytes.length)
    }
    await expect(restoreRepository({ backup: tampered, privateKey: recovery.privateKey, repository: repo, destination: new MemoryStorage() })).rejects.toThrow()
  })

  it('restores into a bare repository that real git accepts', async () => {
    const { dir, storage, recovery, target, names } = await fixture()
    await backupRepository({ source: storage, repository: repo, storage: target, recipient: recovery.publicKey, names })
    const keys = runKeys(target, recovery.privateKey)
    const { snapshot } = await findSnapshot(target, keys, repo)
    const bare = join(tempDir(), 'site.git')
    const write = (path: string, bytes: Uint8Array | string) => {
      mkdirSync(dirname(join(bare, path)), { recursive: true })
      writeFileSync(join(bare, path), bytes)
    }
    mkdirSync(join(bare, 'refs', 'heads'), { recursive: true })
    mkdirSync(join(bare, 'refs', 'tags'), { recursive: true })
    await restoreSnapshot(target, keys, snapshot.repository, {
      index: async (name, bytes) => write(`objects/pack/${name}`, bytes),
      pack: async (name, _size, body) => write(`objects/pack/${name}`, await readAll(body)),
      lfs: async (oid, _size, body) => write(`lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`, await readAll(body)),
      finish: async (refs, packs) => {
        for (const [path, text] of Object.entries(bareRepositoryFiles(refs, packs))) write(path, text)
      },
    })
    execFileSync('git', ['fsck', '--strict', '--no-dangling'], { cwd: bare })
    const clone = join(tempDir(), 'clone')
    execFileSync('git', ['clone', '-q', bare, clone])
    expect(git(clone, ['rev-parse', 'HEAD']).trim()).toBe(git(dir, ['rev-parse', 'HEAD']).trim())
    expect(git(clone, ['tag', '-l']).trim()).toBe('v1')
    expect(hashObject('blob', utf8(`${MARKER}\n`))).toBe(git(clone, ['rev-parse', 'HEAD:secret.txt']).trim())
  })

  it('replicates to a holder that can check the structure but not read it', async () => {
    const { storage, recovery, target, names } = await fixture()
    await backupRepository({ source: storage, repository: repo, storage: target, recipient: recovery.publicKey, names })
    const holder = new MemoryStorage()
    const copied = await replicateBackup(target, holder)
    expect(copied.copied).toBeGreaterThan(0)
    expect((await replicateBackup(target, holder)).copied).toBe(0)
    const report = await checkBackupStructure(holder)
    expect(report).toMatchObject({ objects: 3, snapshots: 1, runs: 1, problems: [] })
    const restored = new MemoryStorage()
    await restoreRepository({ backup: holder, privateKey: recovery.privateKey, repository: repo, destination: restored })
    expect((await readRefs(restored, repo))!.state).toEqual((await readRefs(storage, repo))!.state)

    const broken = new MemoryStorage()
    for await (const info of holder.list('')) {
      if (info.key.startsWith('keys/')) continue
      const object = await holder.get(info.key)
      const bytes = await readAll(object!.body)
      await broken.put(info.key, info.key.startsWith(SNAPSHOTS_PREFIX) ? bytes.slice(0, -1) : bytes, info.key.startsWith(SNAPSHOTS_PREFIX) ? bytes.length - 1 : bytes.length)
    }
    const problems = (await checkBackupStructure(broken)).problems.map((problem) => problem.problem)
    expect(problems.filter((problem) => problem.includes('key record'))).toHaveLength(4)
    expect(problems).toContain('size does not match its header')
  })

  it('refuses to back up a repository that does not exist', async () => {
    const { recovery, target, names } = await fixture()
    await expect(
      backupRepository({ source: new MemoryStorage(), repository: repo, storage: target, recipient: recovery.publicKey, names }),
    ).rejects.toThrow(/does not exist/)
  })
})
