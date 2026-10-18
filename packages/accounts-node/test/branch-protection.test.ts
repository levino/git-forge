import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AccountsStore,
  applyMigrations,
  createAccountsStore,
  createGitAccess,
  DEFAULT_PROTECTION,
  handleBranchProtectionRequest,
  MIGRATIONS,
} from '@git-forge/accounts'
import { createRepository, handleGitRequest, MemoryStorage, readRefs } from '@git-forge/core'
import { commitAll, gitEnv, initRepo, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
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

const bearer = (token: string) => ['-c', `http.extraHeader=Authorization: Bearer ${token}`]

let server: RunningServer
let store: AccountsStore
let storage: MemoryStorage
let repositoryId: string
const tokens: Record<string, string> = {}

beforeAll(async () => {
  storage = new MemoryStorage()
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  store = createAccountsStore(db)
  const owner = await store.createUser({ login: 'olga' })
  const writer = await store.createUser({ login: 'walter' })
  const releaser = await store.createUser({ login: 'rita' })
  const reader = await store.createUser({ login: 'rudi' })
  const village = await store.createOrganization({ login: 'village' })
  await store.setOrganizationMember(village.id, owner.id, 'owner')
  for (const user of [writer, releaser, reader]) await store.setOrganizationMember(village.id, user.id, 'member')
  const repo = await store.createRepository({ ownerId: village.id, name: 'archive', visibility: 'private' })
  repositoryId = repo.id
  const releasers = await store.createTeam(village.id, { slug: 'releasers', name: 'Releasers' })
  await store.setTeamMember(releasers.id, releaser.id)
  for (const user of [writer, releaser]) await store.setCollaborator(repo.id, user.id, 'write')
  await store.setCollaborator(repo.id, reader.id, 'read')
  await createRepository(storage, { owner: 'village', name: 'archive' })
  for (const [name, id] of [['olga', owner.id], ['walter', writer.id], ['rita', releaser.id], ['rudi', reader.id]] as const) {
    tokens[name] = (await store.createPersonalAccessToken(id, { name: 'cli', scopes: ['repo:admin'], expiresAt: null })).token
  }
  const access = createGitAccess({ directory: store })
  server = await startServer(
    async (request) =>
      (await handleBranchProtectionRequest(request, { store })) ??
      (await handleGitRequest(request, { storage, authorize: access.authorize, pushPolicy: access.pushPolicy })) ??
      new Response('not found', { status: 404 }),
  )
})

afterAll(async () => {
  await server.close()
})

const remote = () => `${server.url}/village/archive.git`

const api = (path: string, token: string | null, init: RequestInit = {}) =>
  fetch(`${server.url}/api/repos/village/archive${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...init.headers },
  })

const protect = async (pattern: string, body: unknown) => {
  const response = await api(`/branches/${encodeURIComponent(pattern)}/protection`, tokens.olga!, { method: 'PUT', body: JSON.stringify(body) })
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

const unprotect = async (pattern: string) => {
  expect((await api(`/branches/${encodeURIComponent(pattern)}/protection`, tokens.olga!, { method: 'DELETE' })).status).toBe(204)
}

const clone = async (who: string) => {
  const dir = tempDir()
  await gitAsync(dir, [...bearer(tokens[who]!), 'clone', '-q', remote(), 'out'])
  return `${dir}/out`
}

const commit = (dir: string, file: string) => {
  writeFile(dir, file, `${file}\n`)
  return commitAll(dir, file)
}

const remoteRefs = async () => (await readRefs(storage, { owner: 'village', name: 'archive' }))!.state.refs

describe('branch protection API', () => {
  it('needs admin rights on the repository', async () => {
    expect((await api('/branches/main/protection', null)).status).toBe(401)
    expect((await api('/branches/main/protection', tokens.walter!)).status).toBe(403)
    expect((await api('/branches/main/protection', tokens.olga!)).status).toBe(404)
    expect(await (await api('/branches/main/protection', tokens.olga!)).json()).toEqual({ message: 'Branch not protected' })
    const outsider = await store.createUser({ login: 'mallory' })
    const token = (await store.createPersonalAccessToken(outsider.id, { name: 'cli', scopes: ['repo:admin'], expiresAt: null })).token
    expect((await api('/branches/main/protection', token)).status).toBe(404)
  })

  it('stores a rule in the GitHub shape and lists it', async () => {
    const created = await protect('release/*', {
      required_status_checks: { strict: true, contexts: ['ci'] },
      enforce_admins: true,
      required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: true },
      restrictions: { users: ['rita'], teams: ['releasers'], apps: [], roles: ['maintain'] },
      allow_force_pushes: false,
      allow_deletions: true,
    })
    expect(created).toMatchObject({
      pattern: 'release/*',
      required_status_checks: { strict: true, contexts: ['ci'], checks: [{ context: 'ci', app_id: null }] },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        require_last_push_approval: false,
      },
      restrictions: { users: [{ login: 'rita', type: 'User' }], teams: [{ slug: 'releasers', name: 'Releasers' }], apps: [], roles: ['maintain'] },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: true },
    })
    expect(created.url).toBe(`${server.url}/api/repos/village/archive/branches/release%2F*/protection`)
    expect(await (await api('/branches/release%2F*/protection', tokens.olga!)).json()).toEqual(created)
    const listed = (await (await api('/branch-protection', tokens.olga!)).json()) as unknown[]
    expect(listed).toEqual([created])
    const updated = await protect('release/*', { required_status_checks: null, enforce_admins: null, required_pull_request_reviews: null, restrictions: null })
    expect(updated).not.toHaveProperty('restrictions')
    expect(updated).not.toHaveProperty('required_status_checks')
    expect(updated.enforce_admins).toMatchObject({ enabled: false })
    const rules = await store.branchProtectionRules(repositoryId)
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ ...DEFAULT_PROTECTION, pattern: 'release/*' })
    await unprotect('release/*')
    expect((await api('/branches/release%2F*/protection', tokens.olga!, { method: 'DELETE' })).status).toBe(404)
    expect((await store.auditLog({ repositoryId })).map((entry) => entry.action).filter((action) => action.startsWith('branch_protection'))).toEqual([
      'branch_protection.create',
      'branch_protection.update',
      'branch_protection.delete',
    ])
  })

  it('validates the body', async () => {
    const put = (pattern: string, body: unknown) =>
      api(`/branches/${encodeURIComponent(pattern)}/protection`, tokens.olga!, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) })
    expect((await put('main', 'not json')).status).toBe(400)
    expect((await put('main', [])).status).toBe(400)
    expect((await put('main', { restrictions: { users: ['nobody'] } })).status).toBe(422)
    expect((await put('main', { restrictions: { users: ['village'] } })).status).toBe(422)
    expect((await put('main', { restrictions: { roles: ['owner'] } })).status).toBe(422)
    expect((await put('main', { required_pull_request_reviews: { required_approving_review_count: 7 } })).status).toBe(422)
    expect((await put('main', { allow_force_pushes: 'yes' })).status).toBe(422)
    expect((await put('[main', {})).status).toBe(422)
    expect(await store.branchProtectionRules(repositoryId)).toEqual([])
    expect((await api('/branches/main/protection', tokens.olga!, { method: 'POST' })).status).toBe(405)
  })
})

describe('branch protection with real git', () => {
  it('rejects a force push to a protected branch and archives nothing', async () => {
    const seed = initRepo()
    commit(seed, 'one.txt')
    await gitAsync(seed, [...bearer(tokens.walter!), 'push', '-q', remote(), 'main'])
    await protect('main', { required_status_checks: null, enforce_admins: null, required_pull_request_reviews: null, restrictions: null })
    const dir = await clone('walter')
    await gitAsync(dir, ['commit', '-q', '--amend', '-m', 'rewritten'])
    const before = await remoteRefs()
    const stderr = await gitFails(dir, [...bearer(tokens.walter!), 'push', '--force', 'origin', 'main'])
    expect(stderr).toContain('! [remote rejected] main -> main (protected branch: force push is not allowed)')
    expect(await remoteRefs()).toEqual(before)
    commit(dir, 'two.txt')
    await gitAsync(dir, ['reset', '-q', '--hard', 'origin/main'])
    commit(dir, 'two.txt')
    await gitAsync(dir, [...bearer(tokens.walter!), 'push', '-q', 'origin', 'main'])
  })

  it('rejects deleting a protected branch', async () => {
    const dir = await clone('walter')
    const stderr = await gitFails(dir, [...bearer(tokens.walter!), 'push', 'origin', ':main'])
    expect(stderr).toContain('! [remote rejected] main (protected branch: deletion is not allowed)')
    expect((await remoteRefs())['refs/heads/main']).toBeDefined()
  })

  it('lets admins bypass unless enforce_admins is set', async () => {
    const dir = await clone('olga')
    await gitAsync(dir, ['commit', '-q', '--amend', '-m', 'admin rewrite'])
    await gitAsync(dir, [...bearer(tokens.olga!), 'push', '-q', '--force', 'origin', 'main'])
    expect(Object.keys(await remoteRefs()).some((name) => name.startsWith('refs/archive/'))).toBe(true)
    await protect('main', { required_status_checks: null, enforce_admins: true, required_pull_request_reviews: null, restrictions: null })
    await gitAsync(dir, ['commit', '-q', '--amend', '-m', 'second admin rewrite'])
    expect(await gitFails(dir, [...bearer(tokens.olga!), 'push', '--force', 'origin', 'main'])).toContain('(protected branch: force push is not allowed)')
  })

  it('rejects pushes by users outside the push restrictions', async () => {
    await protect('release/*', {
      required_status_checks: null,
      enforce_admins: true,
      required_pull_request_reviews: null,
      restrictions: { users: [], teams: ['releasers'] },
    })
    const dir = await clone('walter')
    await gitAsync(dir, ['checkout', '-q', '-b', 'release/1.0'])
    commit(dir, 'release.txt')
    const stderr = await gitFails(dir, [...bearer(tokens.walter!), 'push', 'origin', 'release/1.0'])
    expect(stderr).toContain('! [remote rejected] release/1.0 -> release/1.0 (protected branch: you are not allowed to push to this branch)')
    await gitAsync(dir, [...bearer(tokens.rita!), 'push', '-q', 'origin', 'release/1.0'])
    await gitAsync(dir, [...bearer(tokens.walter!), 'push', '-q', 'origin', 'release/1.0:feature/x'])
    expect(Object.keys(await remoteRefs())).toEqual(expect.arrayContaining(['refs/heads/release/1.0', 'refs/heads/feature/x']))
    expect(await gitFails(dir, [...bearer(tokens.rudi!), 'push', 'origin', 'release/1.0:feature/y'])).toMatch(/403|permission denied/i)
  })

  it('rejects direct pushes when pull requests or status checks are required', async () => {
    await protect('main', { required_status_checks: null, enforce_admins: true, required_pull_request_reviews: { required_approving_review_count: 1 }, restrictions: null })
    const dir = await clone('walter')
    commit(dir, 'direct.txt')
    expect(await gitFails(dir, [...bearer(tokens.walter!), 'push', 'origin', 'main'])).toContain('(protected branch: changes must be made through a pull request)')
    await protect('main', { required_status_checks: { strict: false, contexts: ['ci'] }, enforce_admins: true, required_pull_request_reviews: null, restrictions: null })
    expect(await gitFails(dir, [...bearer(tokens.walter!), 'push', 'origin', 'main'])).toContain('(protected branch: required status check "ci" is expected)')
    await unprotect('main')
    await gitAsync(dir, [...bearer(tokens.walter!), 'push', '-q', 'origin', 'main'])
  })

  it('fails the whole push with --atomic when one ref is protected', async () => {
    await protect('main', { required_status_checks: null, enforce_admins: null, required_pull_request_reviews: null, restrictions: null })
    const dir = await clone('walter')
    await gitAsync(dir, ['checkout', '-q', '-b', 'topic'])
    commit(dir, 'topic.txt')
    const stderr = await gitFails(dir, [...bearer(tokens.walter!), 'push', '--atomic', 'origin', 'topic', ':main'])
    expect(stderr).toContain('(protected branch: deletion is not allowed)')
    expect((await remoteRefs())['refs/heads/topic']).toBeUndefined()
  })

  it('keeps refs/upstream/* and refs/archive/* governed by the mirror rules', async () => {
    await protect('*', { required_status_checks: null, enforce_admins: null, required_pull_request_reviews: null, restrictions: null, allow_deletions: true, allow_force_pushes: true })
    const dir = await clone('olga')
    for (const ref of ['refs/upstream/origin/heads/main', 'refs/archive/2026/heads/main']) {
      expect(await gitFails(dir, [...bearer(tokens.olga!), 'push', 'origin', `HEAD:${ref}`])).toContain('(invalid ref name)')
    }
  })
})
