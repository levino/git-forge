import { type AccountsStore, applyMigrations, createAccountsStore, MIGRATIONS, type Principal, type Role } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { createRepository, MemoryStorage, ObjectDatabase, type ObjectId, parsePack, readRefs, type ResolvedObject, updateRefs, writePack, ZERO_ID } from '@git-forge/core'
import { commitAll, git, gitBytes, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type CollaborationOptions, openRepository, type Scope } from '../src/index.ts'

export type Fixture = {
  readonly options: CollaborationOptions
  readonly store: AccountsStore
  readonly storage: MemoryStorage
  readonly dir: string
  readonly users: Readonly<Record<'alice' | 'bob' | 'carol' | 'dave' | 'erin', { id: string; principal: Principal; token: string }>>
  readonly scope: (user: 'alice' | 'bob' | 'carol' | 'dave' | 'erin' | 'anonymous') => Promise<Scope>
  readonly rev: (ref: string) => ObjectId
  readonly sync: (branches?: readonly string[]) => Promise<{ name: string; oldId: string; newId: string }[]>
  readonly clock: { now: number }
}

export const ROLES: Readonly<Record<'bob' | 'carol' | 'dave', Role>> = { bob: 'write', carol: 'read', dave: 'triage' }

export const lines = (count: number, tag = '') => Array.from({ length: count }, (_, i) => `line ${i}${tag}\n`).join('')

export const setupHistory = (dir: string) => {
  writeFile(dir, 'README.md', lines(20))
  writeFile(dir, 'src/app.ts', lines(10, ' app'))
  commitAll(dir, 'initial')
  git(dir, ['checkout', '-q', '-b', 'feature'])
  writeFile(dir, 'README.md', lines(20).replace('line 15\n', 'feature line\n'))
  writeFile(dir, 'docs/new.md', 'new docs\n')
  commitAll(dir, 'feature: docs\n\nFixes #1')
  git(dir, ['checkout', '-q', 'main'])
  writeFile(dir, 'src/app.ts', lines(10, ' app').replace('line 2 app\n', 'main change\n'))
  commitAll(dir, 'main: app change')
  git(dir, ['checkout', '-q', '-b', 'conflict', 'main~1'])
  writeFile(dir, 'src/app.ts', lines(10, ' app').replace('line 2 app\n', 'conflicting change\n'))
  commitAll(dir, 'conflict: app change')
  git(dir, ['checkout', '-q', 'main'])
}

export const createFixture = async (options: { readonly visibility?: 'public' | 'private'; readonly history?: (dir: string) => void } = {}): Promise<Fixture> => {
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const clock = { now: Date.parse('2026-10-18T12:00:00Z') }
  const store = createAccountsStore(db, { now: () => clock.now })
  const names = ['alice', 'bob', 'carol', 'dave', 'erin'] as const
  const users = {} as Record<(typeof names)[number], { id: string; principal: Principal; token: string }>
  for (const login of names) {
    const { id } = await store.createUser({ login, displayName: login[0]!.toUpperCase() + login.slice(1), email: `${login}@example.org` })
    const { token } = await store.createPersonalAccessToken(id, { name: 'test', scopes: ['repo:admin'], expiresAt: null })
    users[login] = { id, token, principal: (await store.authenticateToken(token))! }
  }
  const repository = await store.createRepository({ ownerId: users.alice.id, name: 'site', visibility: options.visibility ?? 'private' })
  for (const [login, role] of Object.entries(ROLES) as [keyof typeof ROLES, Role][]) await store.setCollaborator(repository.id, users[login].id, role)
  const storage = new MemoryStorage()
  const dir = initRepo()
  ;(options.history ?? setupHistory)(dir)
  const repo = { owner: 'alice', name: 'site' }
  const sync = async (branches?: readonly string[]) => {
    const odb = new ObjectDatabase(storage, repo)
    const parsed = await parsePack(gitBytes(dir, ['pack-objects', '--stdout', '--all'], ''), async () => null)
    const missing: ResolvedObject[] = []
    for (const object of parsed.objects) if (!(await odb.has(object.id))) missing.push(object)
    if (missing.length > 0) {
      const pack = writePack(missing)
      await odb.addPack(pack.bytes, pack.objects, pack.checksum)
    }
    const current = (await readRefs(storage, repo))!.state.refs
    const local = git(dir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'])
      .trim()
      .split('\n')
      .map((line) => line.split(' ') as [string, string])
    const changes = local
      .filter(([, name]) => !branches || branches.includes(name.replace('refs/heads/', '')))
      .filter(([id, name]) => current[name] !== id).map(([id, name]) => ({ name, oldId: current[name] ?? ZERO_ID, newId: id }))
    if (changes.length > 0 && !(await updateRefs(storage, repo, changes, odb)).ok) throw new Error('sync failed')
    return changes
  }
  await createRepository(storage, repo)
  await sync()
  const collaboration: CollaborationOptions = { db, storage, accounts: store, now: () => clock.now }
  return {
    options: collaboration,
    store,
    storage,
    dir,
    users,
    clock,
    rev: (ref) => git(dir, ['rev-parse', ref]).trim(),
    sync,
    scope: (user) => openRepository(collaboration, user === 'anonymous' ? { kind: 'anonymous' } : users[user].principal, 'alice', 'site'),
  }
}
