import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cookieNames, createLoginStore, type Database, type Principal, type Row, type Statement } from '@git-forge/accounts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Blob from '../../src/pages/[owner]/[repo]/blob/[...path].astro'
import Commits from '../../src/pages/[owner]/[repo]/commits/[...path].astro'
import RepoHome from '../../src/pages/[owner]/[repo]/index.astro'
import Issue from '../../src/pages/[owner]/[repo]/issues/[number].astro'
import Issues from '../../src/pages/[owner]/[repo]/issues/index.astro'
import Pull from '../../src/pages/[owner]/[repo]/pull/[number]/index.astro'
import Tree from '../../src/pages/[owner]/[repo]/tree/[...path].astro'
import { signIn } from '../../src/ui/sign-in.ts'
import { git, tempDir } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

let forge: NodeForge
let server: RunningServer
let container: AstroContainer
let cookie: string
const statements: string[] = []
const record = (text: string) => statements.push(text.replace(/\s+/g, ' ').trim())

const counting = (db: Database): Database => ({
  all: <T extends Row>(statement: Statement) => (record(statement.sql), db.all<T>(statement)),
  run: (statement) => (record(statement.sql), db.run(statement)),
  batch: (batch) => (record(`batch(${batch.map((item) => item.sql).join('; ')})`), db.batch(batch)),
})

const write = (root: string, path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

const queries = async (page: Parameters<AstroContainer['renderToResponse']>[0], path: string, params: Record<string, string>, signedIn: boolean) => {
  const request = new Request(`${BASE}${path}`, signedIn ? { headers: { Cookie: cookie } } : {})
  statements.length = 0
  const signed = await signIn(forge.services, request)
  const response = await container.renderToResponse(page, {
    request,
    params,
    locals: { forge: forge.services, principal: signed.principal as Principal, session: signed.session, ...(signed.instanceAdmin ? { instanceAdmin: signed.instanceAdmin } : {}) },
    partial: false,
  })
  expect(response.status).toBe(200)
  await response.text()
  return [...statements]
}

beforeAll(async () => {
  const { openSqliteDatabase } = await import('@git-forge/accounts-node')
  const { applyMigrations, MIGRATIONS } = await import('@git-forge/accounts')
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  forge = await nodeForge({ db: counting(db) })
  server = await startServer((request) => forge.fetch(request))
  const token = await bootstrap(forge, BASE, 'olivia')
  expect((await call(forge, BASE, 'POST', '/api/repos', token, { owner: 'olivia', name: 'tracker', visibility: 'public' })).status).toBe(201)
  const dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  write(dir, 'README.md', '# Tracker\n')
  write(dir, 'src/main.ts', 'export const answer = 42\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'Initial commit'])
  await git(dir, ['checkout', '-q', '-b', 'feature'])
  write(dir, 'README.md', '# Tracker\n\nNow with docs.\n')
  await git(dir, ['commit', '-q', '-am', 'Document the tracker'])
  await git(dir, ['push', '-q', `${server.url.replace('://', `://git:${token}@`)}/olivia/tracker.git`, 'main', 'feature'])
  expect((await call(forge, BASE, 'POST', '/api/v3/repos/olivia/tracker/issues', token, { title: 'Broken', body: 'Fix it' })).status).toBe(201)
  expect((await call(forge, BASE, 'POST', '/api/v3/repos/olivia/tracker/pulls', token, { title: 'Docs', head: 'feature', base: 'main', body: 'More docs' })).status).toBe(201)
  const user = (await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } })))!
  const created = await createLoginStore(db).createSession({ userId: user.kind === 'user' ? user.id : '', method: 'oidc', ttlMs: 3_600_000 })
  cookie = `${cookieNames(true).session}=${created.token}`
  container = await AstroContainer.create()
}, 60_000)

afterAll(async () => {
  await server?.close()
})

const PAGES = [
  ['home', RepoHome, '/olivia/tracker', { owner: 'olivia', repo: 'tracker' }, [6, 8]],
  ['tree', Tree, '/olivia/tracker/tree/main/src', { owner: 'olivia', repo: 'tracker', path: 'main/src' }, [5, 7]],
  ['blob', Blob, '/olivia/tracker/blob/main/README.md', { owner: 'olivia', repo: 'tracker', path: 'main/README.md' }, [5, 7]],
  ['commits', Commits, '/olivia/tracker/commits', { owner: 'olivia', repo: 'tracker' }, [5, 7]],
  ['issues', Issues, '/olivia/tracker/issues', { owner: 'olivia', repo: 'tracker' }, [13, 15]],
  ['issue', Issue, '/olivia/tracker/issues/1', { owner: 'olivia', repo: 'tracker', number: '1' }, [15, 18]],
  ['pull', Pull, '/olivia/tracker/pull/2', { owner: 'olivia', repo: 'tracker', number: '2' }, [22, 25]],
] as const

describe('database queries per page', () => {
  it('stays within budget for anonymous and signed-in visitors', async () => {
    const counts: Record<string, readonly number[]> = {}
    for (const [name, page, path, params] of PAGES) {
      await queries(page, path, params, true)
      const anonymous = await queries(page, path, params, false)
      const signed = await queries(page, path, params, true)
      counts[name] = [anonymous.length, signed.length]
      if (process.env.QUERY_LOG) appendFileSync(process.env.QUERY_LOG, `${name}\n  anonymous:\n    ${anonymous.join('\n    ')}\n  signed in:\n    ${signed.join('\n    ')}\n`)
    }
    if (process.env.QUERY_LOG) appendFileSync(process.env.QUERY_LOG, `${JSON.stringify(counts)}\n`)
    for (const [name, , , , budget] of PAGES) expect({ name, within: counts[name]!.every((count, index) => count <= budget[index]!) }).toEqual({ name, within: true })
  })
})
