import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cookieNames, createLoginStore, type Database, lockedStorage,
  REMOTE_WINDOW_MS, type Principal, type Row, type Statement } from '@git-forge/accounts'
import { MemoryStorage, type Storage } from '@git-forge/core'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppJob } from '../../src/app.ts'
import Blob from '../../src/pages/[owner]/[repo]/blob/[...path].astro'
import Commits from '../../src/pages/[owner]/[repo]/commits/[...path].astro'
import RepoHome from '../../src/pages/[owner]/[repo]/index.astro'
import Issue from '../../src/pages/[owner]/[repo]/issues/[number].astro'
import Issues from '../../src/pages/[owner]/[repo]/issues/index.astro'
import Pull from '../../src/pages/[owner]/[repo]/pull/[number]/index.astro'
import Tree from '../../src/pages/[owner]/[repo]/tree/[...path].astro'
import { cachedPage } from '../../src/ui/page-cache.ts'
import { signIn } from '../../src/ui/sign-in.ts'
import { git, tempDir } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

type Tally = { db: number; storage: number; trace: string[] }

let tally: Tally = { db: 0, storage: 0, trace: [] }
const short = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 140)

const counting = (db: Database): Database => ({
  all: <T extends Row>(statement: Statement) => (tally.db++, tally.trace.push(`db ${short(statement.sql)}`), db.all<T>(statement)),
  run: (statement) => (tally.db++, tally.trace.push(`db ${short(statement.sql)}`), db.run(statement)),
  batch: (batch) => (tally.db++, tally.trace.push(`db batch(${batch.map((item) => short(item.sql)).join('; ')})`), db.batch(batch)),
  read: (batch) => (tally.db++, tally.trace.push(`db read(${batch.map((item) => short(item.sql)).join('; ')})`), db.read(batch)),
})

const countingStorage = (storage: Storage): Storage => {
  const note = (op: string, key: string) => (tally.storage++, tally.trace.push(`storage ${op} ${key}`))
  return {
    get: (key, range) => (note('get', key), storage.get(key, range)),
    head: (key) => (note('head', key), storage.head(key)),
    put: (key, body, size, options) => (note('put', key), storage.put(key, body, size, options)),
    list: (prefix) => (note('list', prefix), storage.list(prefix)),
  }
}

let forge: NodeForge
let server: RunningServer
let container: AstroContainer
let cookie: string
let token: string
const jobs: AppJob[] = []
const log = (text: string) => process.env.QUERY_LOG && appendFileSync(process.env.QUERY_LOG, text)

const measure = async (run: () => Promise<unknown>): Promise<Tally> => {
  tally = { db: 0, storage: 0, trace: [] }
  await run()
  const result = tally
  tally = { db: 0, storage: 0, trace: [] }
  return result
}

const drain = async () => {
  while (jobs.length > 0) await forge.runJob(jobs.shift()!)
}

const write = (root: string, path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

const render = (page: Parameters<AstroContainer['renderToResponse']>[0], path: string, params: Record<string, string>, signedIn: boolean) =>
  forge.scope(async () => {
  const request = new Request(`${BASE}${path}`, signedIn ? { headers: { Cookie: cookie } } : {})
  const signed = await signIn(forge.services, request)
  const response = await cachedPage(forge.services, request, signed.principal, () =>
    container.renderToResponse(page, {
      request,
      params,
      locals: { forge: forge.services, principal: signed.principal as Principal, session: signed.session, ...(signed.instanceAdmin ? { instanceAdmin: signed.instanceAdmin } : {}) },
      partial: false,
    }),
  )
  expect(response.status).toBe(200)
  await response.text()
  await forge.services.observe()
  })

const remote = () => `${server.url.replace('://', `://git:${token}@`)}/olivia/tracker.git`

beforeAll(async () => {
  const { openSqliteDatabase } = await import('@git-forge/accounts-node')
  const { applyMigrations, MIGRATIONS } = await import('@git-forge/accounts')
  const { db: raw } = openSqliteDatabase()
  await applyMigrations(raw, MIGRATIONS)
  const db = counting(raw)
  forge = await nodeForge({
    db,
    storage: lockedStorage(countingStorage(new MemoryStorage()), db),
    jobs: { enqueue: async (job) => void jobs.push(job) },
  }, { locks: true, windowMs: REMOTE_WINDOW_MS })
  server = await startServer((request) => (tally.trace.push(`request ${request.method} ${new URL(request.url).pathname}`), forge.fetch(request)))
  token = await bootstrap(forge, BASE, 'olivia')
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
  await git(dir, ['push', '-q', remote(), 'main', 'feature'])
  await drain()
  expect((await call(forge, BASE, 'POST', '/api/v3/repos/olivia/tracker/issues', token, { title: 'Broken', body: 'Fix it' })).status).toBe(201)
  expect((await call(forge, BASE, 'POST', '/api/v3/repos/olivia/tracker/pulls', token, { title: 'Docs', head: 'feature', base: 'main', body: 'More docs' })).status).toBe(201)
  await drain()
  const user = (await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } })))!
  const created = await createLoginStore(raw).createSession({ userId: user.kind === 'user' ? user.id : '', method: 'oidc', ttlMs: 3_600_000 })
  cookie = `${cookieNames(true).session}=${created.token}`
  container = await AstroContainer.create()
}, 60_000)

afterAll(async () => {
  await server?.close()
})

const PAGES = [
  ['home', RepoHome, '/olivia/tracker', { owner: 'olivia', repo: 'tracker' }, [5, 6]],
  ['tree', Tree, '/olivia/tracker/tree/main/src', { owner: 'olivia', repo: 'tracker', path: 'main/src' }, [4, 5]],
  ['blob', Blob, '/olivia/tracker/blob/main/README.md', { owner: 'olivia', repo: 'tracker', path: 'main/README.md' }, [4, 5]],
  ['commits', Commits, '/olivia/tracker/commits', { owner: 'olivia', repo: 'tracker' }, [4, 5]],
  ['issues', Issues, '/olivia/tracker/issues', { owner: 'olivia', repo: 'tracker' }, [6, 6]],
  ['issue', Issue, '/olivia/tracker/issues/1', { owner: 'olivia', repo: 'tracker', number: '1' }, [6, 7]],
  ['pull', Pull, '/olivia/tracker/pull/2', { owner: 'olivia', repo: 'tracker', number: '2' }, [11, 12]],
] as const

const record = (name: string, tallied: Tally) => {
  log(`${name}: db ${tallied.db}, storage ${tallied.storage}\n  ${tallied.trace.join('\n  ')}\n`)
  return tallied.db + tallied.storage
}

const lastRequest = (tallied: Tally, path: string): Tally => {
  const start = tallied.trace.findLastIndex((line) => line.startsWith('request ') && line.endsWith(path))
  const rest = tallied.trace.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('request '))
  const trace = end === -1 ? rest : rest.slice(0, end)
  return { db: trace.filter((line) => line.startsWith('db ')).length, storage: trace.filter((line) => line.startsWith('storage ')).length, trace }
}

describe('round trips per request', () => {
  it('keeps pages within budget for anonymous and signed-in visitors', async () => {
    const counts: Record<string, number[]> = {}
    for (const [name, page, path, params] of PAGES) {
      await render(page, path, params, true)
      counts[name] = [record(`${name} anonymous`, await measure(() => render(page, path, params, false))), record(`${name} signed in`, await measure(() => render(page, path, params, true)))]
    }
    log(`${JSON.stringify(counts)}\n`)
    for (const [name, , , , budget] of PAGES) expect({ name, within: counts[name]!.every((count, index) => count <= budget[index]!) }).toEqual({ name, within: true })
  })

  it('keeps git and API operations within budget', async () => {
    const dir = tempDir()
    await git(dir, ['clone', '-q', remote(), 'work'])
    const work = join(dir, 'work')
    write(work, 'src/next.ts', 'export const next = 43\n')
    await git(work, ['add', '-A'])
    await git(work, ['commit', '-q', '-m', 'Next'])
    const clone = await measure(() => git(tempDir(), ['clone', '-q', remote(), 'again']))
    const push = await measure(() => git(work, ['push', '-q', remote(), 'main']))
    await drain()
    const issue = await measure(() => call(forge, BASE, 'POST', '/api/v3/repos/olivia/tracker/issues', token, { title: 'Again', body: 'Still broken' }))
    const counts = {
      refs: record('info/refs', lastRequest(clone, '/info/refs')),
      fetch: record('upload-pack', lastRequest(clone, '/git-upload-pack')),
      push: record('receive-pack', lastRequest(push, '/git-receive-pack')),
      issue: record('issue', issue),
    }
    log(`${JSON.stringify(counts)}\n`)
    expect(counts).toEqual({ refs: Math.min(counts.refs, 3), fetch: Math.min(counts.fetch, 3), push: Math.min(counts.push, 22), issue: Math.min(counts.issue, 6) })
  })
})
