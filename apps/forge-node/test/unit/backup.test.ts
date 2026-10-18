import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from '@git-forge/accounts'
import { generateRecoveryKey } from '@git-forge/backup'
import { ObjectDatabase, readRefs, streamOf, updateRefs, ZERO_ID } from '@git-forge/core'
import { commitAll, gitBytes, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli.ts'
import { matchesPattern, parseBackupConfig } from '../../src/backup.ts'
import { createInstance } from '../../src/instance.ts'

const root = mkdtempSync(join(tmpdir(), 'git-forge-node-backup-'))
const fresh = () => mkdtempSync(join(root, 'case-'))

afterAll(() => rm(root, { recursive: true, force: true }))

const quiet = () => undefined

describe('backup configuration', () => {
  it('is off without a recovery key and validates everything else', async () => {
    const { publicKey, privateKey } = await generateRecoveryKey()
    expect(parseBackupConfig({})).toBeNull()
    const base = { BACKUP_RECOVERY_KEY: JSON.stringify(publicKey), BACKUP_SECRET: 'x'.repeat(32) }
    expect(parseBackupConfig({ ...base, DATA_DIR: '/srv' })).toMatchObject({ repositories: ['*'], target: { kind: 'fs', dir: '/srv/backup' } })
    expect(parseBackupConfig({ ...base, BACKUP_SCHEDULE: 'off' })?.schedule).toBeNull()
    expect(parseBackupConfig(base)?.schedule?.source).toBe('47 3 * * *')
    expect(() => parseBackupConfig({ ...base, BACKUP_RECOVERY_KEY: JSON.stringify(privateKey) })).toThrow(/public key/)
    expect(() => parseBackupConfig({ ...base, BACKUP_SECRET: 'short' })).toThrow(/BACKUP_SECRET/)
    expect(() => parseBackupConfig({ ...base, BACKUP_REPOSITORIES: 'nope' })).toThrow(/BACKUP_REPOSITORIES/)
    expect(() => parseBackupConfig({ ...base, BACKUP_STORAGE: 's3' })).toThrow('BACKUP_S3_ENDPOINT is required with BACKUP_STORAGE=s3')
    expect(
      parseBackupConfig({
        ...base,
        BACKUP_STORAGE: 's3',
        BACKUP_S3_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
        BACKUP_S3_BUCKET: 'vault',
        BACKUP_S3_ACCESS_KEY_ID: 'id',
        BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
      })?.target,
    ).toMatchObject({ kind: 's3', config: { bucket: 'vault', region: 'us-east-1' } })
    expect(matchesPattern('acme/*', { owner: 'ACME', name: 'site' })).toBe(true)
    expect(matchesPattern('acme/site', { owner: 'acme', name: 'other' })).toBe(false)
  })
})

describe('backup and restore commands', () => {
  it('backs up repositories with their issues and restores them into a new instance', async () => {
    const recovery = await generateRecoveryKey()
    const keyFile = join(root, 'recovery.jwk')
    writeFileSync(keyFile, JSON.stringify(recovery.privateKey))
    const backup = {
      BACKUP_RECOVERY_KEY: JSON.stringify(recovery.publicKey),
      BACKUP_SECRET: 'a secret that names objects in the bucket',
      BACKUP_REPOSITORIES: 'pi/site',
      BACKUP_DIR: fresh(),
    }
    const source = { DATA_DIR: fresh(), BOOTSTRAP_TOKEN: 'secret', ...backup }
    expect(await main(['migrate'], source, quiet)).toBe(0)
    const instance = await createInstance(source, { log: quiet })
    let head: string
    try {
      const bootstrap = await instance.forge.fetch(
        new Request('http://forge.test/api/bootstrap', { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: JSON.stringify({ login: 'pi' }) }),
      )
      const { token } = (await bootstrap.json()) as { token: string }
      const auth = { Authorization: `Bearer ${token}` }
      for (const name of ['site', 'skipped']) {
        const created = await instance.forge.fetch(new Request('http://forge.test/api/repos', { method: 'POST', headers: auth, body: JSON.stringify({ owner: 'pi', name }) }))
        expect(created.status).toBe(201)
      }
      const dir = initRepo()
      writeFile(dir, 'README.md', '# site\n')
      head = commitAll(dir, 'first')
      const repo = { owner: 'pi', name: 'site' }
      const odb = new ObjectDatabase(instance.storage, repo)
      await odb.ingest(streamOf(gitBytes(dir, ['pack-objects', '--stdout', '--revs'], `${head}\n`)))
      expect((await updateRefs(instance.storage, repo, [{ name: 'refs/heads/main', oldId: ZERO_ID, newId: head }], new ObjectDatabase(instance.storage, repo))).ok).toBe(true)
      const issue = await instance.forge.fetch(
        new Request('http://forge.test/api/v3/repos/pi/site/issues', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Restore me', body: 'please' }) }),
      )
      expect(issue.status).toBe(201)
    } finally {
      await instance.close()
    }
    const events: Record<string, unknown>[] = []
    expect(await main(['backup'], source, (event) => events.push(event))).toBe(0)
    expect(events).toEqual([expect.objectContaining({ event: 'backup', repo: 'pi/site', unchanged: false, uploaded: 3 })])
    expect(await main(['backup'], source, (event) => events.push(event))).toBe(0)
    expect(events[1]).toMatchObject({ repo: 'pi/site', unchanged: true, uploaded: 0 })
    expect(readdirSync(backup.BACKUP_DIR).filter((name) => !name.startsWith('.')).sort()).toEqual(['README.txt', 'keys', 'objects', 'seen', 'snapshots'])

    const target = { DATA_DIR: fresh(), ...backup }
    expect(await main(['migrate'], target, quiet)).toBe(0)
    const restored: Record<string, unknown>[] = []
    expect(await main(['restore', 'pi/site', '--key', keyFile, '--as', 'pi/recovered'], target, (event) => restored.push(event))).toBe(0)
    expect(restored.at(-1)).toMatchObject({ event: 'restored', packs: 1, lfs: 0, rows: expect.any(Number) })
    const after = await createInstance(target, { log: quiet })
    try {
      expect((await readRefs(after.storage, { owner: 'pi', name: 'recovered' }))?.state.refs['refs/heads/main']).toBe(head!)
      const issues = await after.db.all<{ title: string; body: string }>(
        sql("SELECT i.title, i.body FROM issues i JOIN repositories r ON r.id = i.repository_id WHERE r.name = 'recovered'"),
      )
      expect(issues).toEqual([{ title: 'Restore me', body: 'please' }])
    } finally {
      await after.close()
    }
    const stderr: string[] = []
    const write = process.stderr.write
    process.stderr.write = ((chunk: string) => (stderr.push(chunk), true)) as typeof process.stderr.write
    try {
      expect(await main(['restore', 'pi/site', '--key', keyFile, '--as', 'pi/recovered'], target, quiet)).toBe(2)
      expect(stderr.join('')).toContain('exists')
    } finally {
      process.stderr.write = write
    }
  })
})
