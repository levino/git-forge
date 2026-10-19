import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Principal, UserPrincipal } from '@git-forge/accounts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UiSession } from '../../src/app.ts'
import Blob from '../../src/pages/[owner]/[repo]/blob/[...path].astro'
import Edit from '../../src/pages/[owner]/[repo]/edit/[...path].astro'
import Issue from '../../src/pages/[owner]/[repo]/issues/[number].astro'
import Conflicts from '../../src/pages/[owner]/[repo]/pull/[number]/conflicts.astro'
import Pull from '../../src/pages/[owner]/[repo]/pull/[number]/index.astro'
import { storeLfsObject, streamOf } from '@git-forge/core'
import { git, tempDir } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

let forge: NodeForge
let server: RunningServer
let container: AstroContainer
let owner: UserPrincipal
let ownerToken: string
let reader: UserPrincipal

const write = (root: string, path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

const principalFor = async (token: string) => (await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } }))) as UserPrincipal

const sessionOf = (principal: UserPrincipal): UiSession => ({ principal, csrf: 'csrf-token', sessionId: 'session-1' })

const render = async (page: Parameters<AstroContainer['renderToResponse']>[0], path: string, params: Record<string, string>, principal: Principal, body?: Record<string, string> | FormData) => {
  const session = principal.kind === 'user' ? sessionOf(principal) : null
  const draft = body ? new Request(`${BASE}${path}`, { method: 'POST', body: body instanceof FormData ? body : new URLSearchParams(body) }) : null
  const bytes = draft ? new Uint8Array(await draft.arrayBuffer()) : null
  const request = draft && bytes ? new Request(draft.url, { method: 'POST', headers: { 'Content-Type': draft.headers.get('Content-Type')!, 'Content-Length': String(bytes.length) }, body: bytes }) : new Request(`${BASE}${path}`)
  const response = await container.renderToResponse(page, { request, params, locals: { forge: { ...forge.services, verifySessionWrite: async () => session }, principal, session }, partial: false })
  return { status: response.status, location: response.headers.get('Location'), html: await response.text() }
}

const contents = async (path: string, ref = 'main') => {
  const response = await call(forge, BASE, 'GET', `/api/v3/repos/olivia/notes/contents/${path}?ref=${ref}`, ownerToken)
  return response.status === 200 ? Buffer.from(((await response.json()) as { content: string }).content, 'base64').toString('utf8') : null
}

beforeAll(async () => {
  forge = await nodeForge()
  server = await startServer((request) => forge.fetch(request))
  ownerToken = await bootstrap(forge, BASE, 'olivia')
  owner = await principalFor(ownerToken)
  expect((await call(forge, BASE, 'POST', '/api/admin/users', ownerToken, { login: 'rita' })).status).toBe(201)
  reader = await principalFor(((await (await call(forge, BASE, 'POST', '/api/admin/users/rita/tokens', ownerToken, { scopes: ['repo:write'] })).json()) as { token: string }).token)
  expect((await call(forge, BASE, 'POST', '/api/repos', ownerToken, { owner: 'olivia', name: 'notes', visibility: 'public' })).status).toBe(201)
  const dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  write(dir, 'README.md', '# Notes\n\nfirst\n')
  write(dir, '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'Initial commit'])
  await git(dir, ['checkout', '-q', '-b', 'topic'])
  write(dir, 'README.md', '# Notes\n\ntopic\n')
  await git(dir, ['commit', '-q', '-am', 'Topic change'])
  await git(dir, ['checkout', '-q', 'main'])
  write(dir, 'README.md', '# Notes\n\nmain\n')
  await git(dir, ['commit', '-q', '-am', 'Main change'])
  await git(dir, ['push', '-q', `${server.url.replace('://', `://git:${ownerToken}@`)}/olivia/notes.git`, 'main', 'topic'])
  container = await AstroContainer.create()
}, 60_000)

afterAll(async () => {
  await server?.close()
})

describe('editing files in the browser', () => {
  it('links edit and delete from the file view and commits an edit directly', async () => {
    const blob = await render(Blob, '/olivia/notes/blob/main/README.md', { owner: 'olivia', repo: 'notes', path: 'main/README.md' }, owner)
    expect(blob.html).toContain('href="/olivia/notes/edit/main/README.md"')
    expect(blob.html).toContain('href="/olivia/notes/edit/main/README.md?mode=delete"')
    const params = { owner: 'olivia', repo: 'notes', path: 'main/README.md' }
    const form = await render(Edit, '/olivia/notes/edit/main/README.md', params, owner)
    expect(form.html).toContain('# Notes\n\nmain\n</textarea>')
    expect(form.html).toContain('Commit directly to the main branch')
    const sha = /name="sha" value="([0-9a-f]{40})"/.exec(form.html)![1]!
    const saved = await render(Edit, '/olivia/notes/edit/main/README.md', params, owner, { csrf: 'csrf-token', sha, path: 'README.md', content: '# Notes\r\n\r\nedited\r\n', message: '', target: 'direct' })
    expect(saved).toMatchObject({ status: 303, location: '/olivia/notes/blob/main/README.md' })
    expect(await contents('README.md')).toBe('# Notes\n\nedited\n')
    const stale = await render(Edit, '/olivia/notes/edit/main/README.md', params, owner, { csrf: 'csrf-token', sha, path: 'README.md', content: 'x', target: 'direct' })
    expect(stale.status).toBe(409)
    expect(stale.html).toContain('README.md does not match')
  })

  it('creates files on a new branch with a pull request, uploads LFS files and deletes', async () => {
    const tree = { owner: 'olivia', repo: 'notes', path: 'main' }
    const created = await render(Edit, '/olivia/notes/edit/main?mode=new', tree, owner, { csrf: 'csrf-token', path: 'docs/idea.md', content: 'idea\n', message: 'Add idea', target: 'branch', branch: 'idea', pull: '1' })
    expect(created).toMatchObject({ status: 303, location: '/olivia/notes/pull/1' })
    expect(await contents('docs/idea.md', 'idea')).toBe('idea\n')
    const upload = new FormData()
    upload.set('csrf', 'csrf-token')
    upload.set('target', 'direct')
    upload.append('files', new File([new Uint8Array([1, 2, 3])], 'data.bin'))
    upload.append('files', new File(['plain\n'], 'plain.txt'))
    const uploaded = await render(Edit, '/olivia/notes/edit/main?mode=upload', tree, owner, upload)
    expect(uploaded).toMatchObject({ status: 303, location: '/olivia/notes/tree/main' })
    expect(await contents('plain.txt')).toBe('plain\n')
    expect(await contents('data.bin')).toMatch(/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize 3\n$/)
    const object = new TextEncoder().encode('large object\n')
    const oid = Buffer.from(await crypto.subtle.digest('SHA-256', object)).toString('hex')
    const prepared = await render(Edit, '/olivia/notes/edit/main?mode=upload&prepare=1', tree, owner, { csrf: 'csrf-token', name: 'big.bin' })
    expect(JSON.parse(prepared.html)).toEqual({ repository: 'olivia/notes', lfs: ['big.bin'] })
    const pointer = new FormData()
    pointer.set('csrf', 'csrf-token')
    pointer.set('target', 'direct')
    pointer.append('lfs', `${oid} ${object.length} big file.bin`)
    expect((await render(Edit, '/olivia/notes/edit/main?mode=upload', tree, owner, pointer)).html).toContain('was not uploaded')
    expect((await storeLfsObject(forge.storage, { owner: 'olivia', name: 'notes' }, { oid, size: object.length }, streamOf(object))).ok).toBe(true)
    expect(await render(Edit, '/olivia/notes/edit/main?mode=upload', tree, owner, pointer)).toMatchObject({ status: 303 })
    expect(await contents('big%20file.bin')).toBe(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${object.length}\n`)
    const huge = new FormData()
    huge.set('csrf', 'csrf-token')
    huge.append('files', new File([new Uint8Array(11 * 1024 * 1024)], 'huge.txt'))
    const refused = await render(Edit, '/olivia/notes/edit/main?mode=upload', tree, owner, huge)
    expect(refused.status).toBe(413)
    const removed = await render(Edit, '/olivia/notes/edit/main/plain.txt?mode=delete', { owner: 'olivia', repo: 'notes', path: 'main/plain.txt' }, owner, { csrf: 'csrf-token', target: 'direct' })
    expect(removed).toMatchObject({ status: 303, location: '/olivia/notes/tree/main' })
    expect(await contents('plain.txt')).toBeNull()
  })

  it('proposes changes from a reader through a fork', async () => {
    const params = { owner: 'olivia', repo: 'notes', path: 'main/README.md' }
    const form = await render(Edit, '/olivia/notes/edit/main/README.md', params, reader)
    expect(form.html).toContain('Your change is committed to a new branch of your fork')
    const proposed = await render(Edit, '/olivia/notes/edit/main/README.md', params, reader, { csrf: 'csrf-token', path: 'README.md', content: '# Notes\n\nproposed\n', message: 'Propose' })
    expect(proposed).toMatchObject({ status: 303, location: '/olivia/notes/pull/2' })
    const pull = await (await call(forge, BASE, 'GET', '/api/v3/repos/olivia/notes/pulls/2', ownerToken)).json()
    expect(pull).toMatchObject({ title: 'Propose', head: { ref: 'patch-1', repo: { full_name: 'rita/notes' } }, base: { ref: 'main' } })
  })
})

describe('resolving conflicts in the browser', () => {
  it('shows conflict markers and commits the resolution to the head branch', async () => {
    const opened = await call(forge, BASE, 'POST', '/api/v3/repos/olivia/notes/pulls', ownerToken, { title: 'Topic', head: 'topic', base: 'main' })
    const { number } = (await opened.json()) as { number: number }
    const params = { owner: 'olivia', repo: 'notes', number: String(number) }
    const pull = await render(Pull, `/olivia/notes/pull/${number}`, params, owner)
    expect(pull.html).toContain(`href="/olivia/notes/pull/${number}/conflicts"`)
    const page = await render(Conflicts, `/olivia/notes/pull/${number}/conflicts`, params, owner)
    expect(page.html).toContain('&lt;&lt;&lt;&lt;&lt;&lt;&lt; topic\ntopic\n=======\nedited\n&gt;&gt;&gt;&gt;&gt;&gt;&gt; main\n')
    const sha = /name="sha" value="([0-9a-f]{40})"/.exec(page.html)![1]!
    const resolved = await render(Conflicts, `/olivia/notes/pull/${number}/conflicts`, params, owner, { csrf: 'csrf-token', sha, path: 'README.md', content: '# Notes\r\n\r\ntopic and edited\r\n', message: '' })
    expect(resolved).toMatchObject({ status: 303, location: `/olivia/notes/pull/${number}` })
    expect(await contents('README.md', 'topic')).toBe('# Notes\n\ntopic and edited\n')
    expect(((await (await call(forge, BASE, 'GET', `/api/v3/repos/olivia/notes/pulls/${number}`, ownerToken)).json()) as { mergeable: boolean }).mergeable).toBe(true)
  })
})

describe('reactions in the browser', () => {
  it('toggles a reaction on an issue', async () => {
    await call(forge, BASE, 'POST', '/api/v3/repos/olivia/notes/issues', ownerToken, { title: 'Question' })
    const issues = (await (await call(forge, BASE, 'GET', '/api/v3/repos/olivia/notes/issues?state=all', ownerToken)).json()) as { number: number; pull_request?: unknown }[]
    const number = String(issues.find((issue) => !issue.pull_request)!.number)
    const params = { owner: 'olivia', repo: 'notes', number }
    const reacted = await render(Issue, `/olivia/notes/issues/${number}`, params, reader, { csrf: 'csrf-token', action: 'react', kind: 'issue', subject: number, content: 'heart' })
    expect(reacted.status).toBe(303)
    const page = await render(Issue, `/olivia/notes/issues/${number}`, params, reader)
    expect(page.html).toContain('aria-pressed="true" aria-label="heart: 1"')
    const json = (await (await call(forge, BASE, 'GET', `/api/v3/repos/olivia/notes/issues/${number}`, ownerToken)).json()) as { reactions: Record<string, number> }
    expect(json.reactions).toMatchObject({ total_count: 1, heart: 1 })
  })
})
