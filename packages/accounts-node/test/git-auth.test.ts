import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AccountsStore,
  applyMigrations,
  createAccountsStore,
  createGitAuthorizer,
  createInstanceVerifier,
  createJwksCache,
  generateSigningKey,
  handleWellKnownRequest,
  MIGRATIONS,
  mintInstanceToken,
  type SigningKey,
} from '@git-forge/accounts'
import { type Authorize, createRepository, handleGitRequest, MemoryStorage } from '@git-forge/core'
import { gitEnv, initRepo, sampleHistory, tempDir, writeFile, commitAll } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { openSqliteDatabase } from '../src/index.ts'

const run = promisify(execFile)

const gitAsync = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, ...gitEnv }, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

const gitFails = async (cwd: string, args: readonly string[]): Promise<string> => {
  try {
    await gitAsync(cwd, args)
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error)
  }
  throw new Error(`git ${args.join(' ')} unexpectedly succeeded`)
}

const AUTH_FAILED = /Authentication failed|could not read Username|401/

const bearer = (token: string) => ['-c', `http.extraHeader=Authorization: Bearer ${token}`]

const withCredentials = (url: string, user: string, password: string) => {
  const parsed = new URL(url)
  parsed.username = user
  parsed.password = password
  return parsed.href
}

let source: RunningServer
let backup: RunningServer
let store: AccountsStore
let backupKey: SigningKey
const tokens: Record<string, string> = {}

beforeAll(async () => {
  const storage = new MemoryStorage()
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  store = createAccountsStore(db)

  const alice = await store.createUser({ login: 'alice' })
  const bob = await store.createUser({ login: 'bob' })
  const mallory = await store.createUser({ login: 'mallory' })
  const village = await store.createOrganization({ login: 'village' })
  await store.setOrganizationMember(village.id, alice.id, 'owner')
  const archive = await store.createRepository({ ownerId: village.id, name: 'archive', visibility: 'private' })
  await store.createRepository({ ownerId: village.id, name: 'secret', visibility: 'private' })
  await store.createRepository({ ownerId: village.id, name: 'site', visibility: 'public' })
  await store.setCollaborator(archive.id, bob.id, 'read')
  for (const name of ['archive', 'secret', 'site']) await createRepository(storage, { owner: 'village', name })

  tokens.alice = (await store.createPersonalAccessToken(alice.id, { name: 'cli', scopes: ['repo:write'], expiresAt: null })).token
  tokens.aliceReadOnly = (await store.createPersonalAccessToken(alice.id, { name: 'ro', scopes: ['repo:read'], expiresAt: null })).token
  tokens.bob = (await store.createPersonalAccessToken(bob.id, { name: 'cli', scopes: ['repo:write'], expiresAt: null })).token
  tokens.mallory = (await store.createPersonalAccessToken(mallory.id, { name: 'cli', scopes: ['repo:admin'], expiresAt: null })).token

  backupKey = (await generateSigningKey()).key
  backup = await startServer(async (request) => handleWellKnownRequest(request, { issuer: backup.url, keys: [backupKey.publicJwk] }) ?? new Response('not found', { status: 404 }))

  const jwks = createJwksCache({ allowInsecureHttp: true })
  let authorize: Authorize = async () => new Response('starting', { status: 503 })
  source = await startServer(async (request) => (await handleGitRequest(request, { storage, authorize })) ?? new Response('not found', { status: 404 }))
  authorize = createGitAuthorizer({
    directory: store,
    verifyInstance: createInstanceVerifier({ audience: source.url, trust: store.lookupTrustedIssuer, jwks }),
  })

  await store.trustInstance({ issuer: backup.url })
  await store.grantInstanceRepository(backup.url, archive.id)
})

afterAll(async () => {
  await source.close()
  await backup.close()
})

const remote = (name: string) => `${source.url}/village/${name}.git`

const pushSample = async (name: string) => {
  const dir = initRepo()
  sampleHistory(dir, 2)
  await gitAsync(dir, [...bearer(tokens.alice!), 'push', '-q', remote(name), 'main'])
  return dir
}

describe('git with accounts', () => {
  it('rejects anonymous access to a private repository with a Basic challenge', async () => {
    await pushSample('archive')
    const response = await fetch(`${remote('archive')}/info/refs?service=git-upload-pack`)
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="git-forge"')
    expect(await gitFails(tempDir(), ['clone', '-q', remote('archive'), 'out'])).toMatch(AUTH_FAILED)
  })

  it('clones a private repository with a token in http.extraHeader', async () => {
    const dir = tempDir()
    await gitAsync(dir, [...bearer(tokens.bob!), 'clone', '-q', remote('archive'), 'out'])
    expect(await gitAsync(`${dir}/out`, ['log', '--format=%s'])).toBe('commit 1\ncommit 0\n')
  })

  it('clones a private repository with the token as Basic password in the URL', async () => {
    const dir = tempDir()
    await gitAsync(dir, ['clone', '-q', withCredentials(remote('archive'), 'bob', tokens.bob!), 'out'])
    expect(await gitAsync(`${dir}/out`, ['rev-parse', '--is-inside-work-tree'])).toBe('true\n')
    const dumb = tempDir()
    await gitAsync(dumb, ['-c', 'protocol.version=0', 'clone', '-q', withCredentials(remote('archive'), 'x', tokens.bob!), 'out'])
    expect(await gitAsync(`${dumb}/out`, ['fsck', '--full'])).toBe('')
  })

  it('rejects a wrong token with 401', async () => {
    expect(await gitFails(tempDir(), ['clone', '-q', withCredentials(remote('archive'), 'bob', 'gfp_' + 'x'.repeat(43)), 'out'])).toMatch(
      AUTH_FAILED,
    )
  })

  it('hides private repositories from authenticated outsiders with 404', async () => {
    const response = await fetch(`${remote('archive')}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Bearer ${tokens.mallory}` } })
    expect(response.status).toBe(404)
    expect(await gitFails(tempDir(), [...bearer(tokens.mallory!), 'clone', '-q', remote('archive'), 'out'])).toMatch(/not found|404/)
    const missing = await fetch(`${remote('nothing')}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Bearer ${tokens.mallory}` } })
    expect(missing.status).toBe(404)
  })

  it('needs write access to push', async () => {
    const dir = tempDir()
    await gitAsync(dir, [...bearer(tokens.bob!), 'clone', '-q', remote('archive'), 'out'])
    writeFile(`${dir}/out`, 'bob.txt', 'bob\n')
    commitAll(`${dir}/out`, 'from bob')
    expect(await gitFails(`${dir}/out`, [...bearer(tokens.bob!), 'push', 'origin', 'main'])).toMatch(/403|permission denied/i)
    expect(await gitFails(`${dir}/out`, [...bearer(tokens.aliceReadOnly!), 'push', 'origin', 'main'])).toMatch(/403|permission denied/i)
    await gitAsync(`${dir}/out`, [...bearer(tokens.alice!), 'push', '-q', 'origin', 'main'])
    expect(await gitAsync(dir, [...bearer(tokens.bob!), 'ls-remote', remote('archive'), 'refs/heads/main'])).toContain(
      await gitAsync(`${dir}/out`, ['rev-parse', 'HEAD']).then((id) => id.trim()),
    )
  })

  it('lets anyone clone a public repository but asks for credentials to push', async () => {
    await pushSample('site')
    const dir = tempDir()
    await gitAsync(dir, ['clone', '-q', remote('site'), 'out'])
    writeFile(`${dir}/out`, 'anon.txt', 'anon\n')
    commitAll(`${dir}/out`, 'anonymous')
    expect(await gitFails(`${dir}/out`, ['push', 'origin', 'main'])).toMatch(AUTH_FAILED)
    expect(await gitFails(`${dir}/out`, [...bearer(tokens.mallory!), 'push', 'origin', 'main'])).toMatch(/403|permission denied/i)
  })

  it('lets a trusted instance clone exactly the repositories it was granted', async () => {
    await pushSample('secret')
    const mint = (repositories: string[], audience = source.url) =>
      mintInstanceToken({ key: backupKey, issuer: backup.url, audience, repositories })
    const dir = tempDir()
    await gitAsync(dir, [...bearer(await mint(['village/archive'])), 'clone', '-q', remote('archive'), 'out'])
    expect(await gitAsync(`${dir}/out`, ['log', '-1', '--format=%s'])).toBe('from bob\n')
    expect(await gitFails(tempDir(), [...bearer(await mint(['village/secret'])), 'clone', '-q', remote('secret'), 'out'])).toMatch(/not found|404/)
    expect(await gitFails(tempDir(), [...bearer(await mint(['village/secret'])), 'clone', '-q', remote('archive'), 'out'])).toMatch(/not found|404/)
    expect(await gitFails(tempDir(), [...bearer(await mint(['village/archive'], 'https://elsewhere.example')), 'clone', '-q', remote('archive'), 'out'])).toMatch(
      AUTH_FAILED,
    )
    writeFile(`${dir}/out`, 'mirror.txt', 'mirror\n')
    commitAll(`${dir}/out`, 'from mirror')
    expect(await gitFails(`${dir}/out`, [...bearer(await mint(['village/archive'])), 'push', 'origin', 'main'])).toMatch(/403|permission denied/i)
    const gitOnly = await mintInstanceToken({ key: backupKey, issuer: backup.url, audience: source.url, repositories: ['village/archive'], scopes: ['git:read'] })
    const lfsBatch = (token: string) =>
      fetch(`${remote('archive')}/info/lfs/objects/batch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.git-lfs+json' },
        body: JSON.stringify({ operation: 'download', objects: [{ oid: 'a'.repeat(64), size: 1 }] }),
      })
    expect((await lfsBatch(gitOnly)).status).toBe(404)
    expect((await lfsBatch(await mint(['village/archive']))).status).toBe(200)
    const lfsOnly = await mintInstanceToken({ key: backupKey, issuer: backup.url, audience: source.url, repositories: ['village/archive'], scopes: ['lfs:read'] })
    expect((await fetch(`${remote('archive')}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Bearer ${lfsOnly}` } })).status).toBe(404)
    const viaPassword = tempDir()
    await gitAsync(viaPassword, ['clone', '-q', withCredentials(remote('archive'), 'instance', await mint(['village/archive'])), 'out'])
  })
})
