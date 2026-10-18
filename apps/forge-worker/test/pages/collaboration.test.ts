import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Principal, UserPrincipal } from '@git-forge/accounts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UiSession } from '../../src/app.ts'
import Discussion from '../../src/pages/[owner]/[repo]/discussions/[number].astro'
import Discussions from '../../src/pages/[owner]/[repo]/discussions/index.astro'
import NewDiscussion from '../../src/pages/[owner]/[repo]/discussions/new.astro'
import Issue from '../../src/pages/[owner]/[repo]/issues/[number].astro'
import Issues from '../../src/pages/[owner]/[repo]/issues/index.astro'
import NewIssue from '../../src/pages/[owner]/[repo]/issues/new.astro'
import PullCommits from '../../src/pages/[owner]/[repo]/pull/[number]/commits.astro'
import PullFiles from '../../src/pages/[owner]/[repo]/pull/[number]/files.astro'
import Pull from '../../src/pages/[owner]/[repo]/pull/[number]/index.astro'
import Pulls from '../../src/pages/[owner]/[repo]/pulls/index.astro'
import NewPull from '../../src/pages/[owner]/[repo]/pulls/new.astro'
import { git, tempDir } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'
const ANONYMOUS: Principal = { kind: 'anonymous' }

let forge: NodeForge
let server: RunningServer
let container: AstroContainer
let owner: UserPrincipal
let reader: UserPrincipal

const write = (root: string, path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

const principalFor = async (token: string) => (await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } }))) as UserPrincipal

type Render = { readonly principal?: Principal; readonly session?: UiSession | null; readonly form?: Record<string, string> }

const render = async (page: Parameters<AstroContainer['renderToResponse']>[0], path: string, params: Record<string, string>, options: Render = {}) => {
  const principal = options.principal ?? ANONYMOUS
  const session = options.session ?? null
  const request = options.form
    ? new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(options.form) })
    : new Request(`${BASE}${path}`)
  const response = await container.renderToResponse(page, {
    request,
    params,
    locals: { forge: { ...forge.services, verifySessionWrite: async () => session }, principal, session },
    partial: false,
  })
  return { status: response.status, location: response.headers.get('Location'), html: await response.text() }
}

const sessionOf = (principal: UserPrincipal): UiSession => ({ principal, csrf: 'csrf-token' })

beforeAll(async () => {
  forge = await nodeForge()
  server = await startServer((request) => forge.fetch(request))
  const token = await bootstrap(forge, BASE, 'olivia')
  owner = await principalFor(token)
  expect((await call(forge, BASE, 'POST', '/api/admin/users', token, { login: 'rita' })).status).toBe(201)
  const readerToken = ((await (await call(forge, BASE, 'POST', '/api/admin/users/rita/tokens', token, { scopes: ['repo:write'] })).json()) as { token: string }).token
  reader = await principalFor(readerToken)
  expect((await call(forge, BASE, 'POST', '/api/repos', token, { owner: 'olivia', name: 'tracker', visibility: 'public' })).status).toBe(201)
  const dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  write(dir, 'README.md', '# Tracker\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'Initial commit'])
  await git(dir, ['checkout', '-q', '-b', 'feature'])
  write(dir, 'README.md', '# Tracker\n\nNow with docs.\n')
  await git(dir, ['commit', '-q', '-am', 'Document the tracker'])
  await git(dir, ['push', '-q', `${server.url.replace('://', `://git:${token}@`)}/olivia/tracker.git`, 'main', 'feature'])
  container = await AstroContainer.create()
}, 60_000)

afterAll(async () => {
  await server?.close()
})

describe('issue pages', () => {
  it('opens an issue from the form and shows it with sanitized Markdown', async () => {
    const created = await render(NewIssue, '/olivia/tracker/issues/new', { owner: 'olivia', repo: 'tracker' }, {
      principal: owner,
      session: sessionOf(owner),
      form: { csrf: 'csrf-token', title: 'Broken <b>link</b>', body: 'See the [readme](README.md).\n\n<script>alert(1)</script>' },
    })
    expect(created).toMatchObject({ status: 303, location: '/olivia/tracker/issues/1' })
    const page = await render(Issue, '/olivia/tracker/issues/1', { owner: 'olivia', repo: 'tracker', number: '1' })
    expect(page.status).toBe(200)
    expect(page.html).toContain('Broken &lt;b&gt;link&lt;/b&gt;')
    expect(page.html).toContain('href="/olivia/tracker/blob/main/README.md"')
    expect(page.html).not.toContain('<script>alert')
    expect(page.html).toContain('Sign in</a> to comment')
  })

  it('refuses the form without a valid session write', async () => {
    const refused = await render(NewIssue, '/olivia/tracker/issues/new', { owner: 'olivia', repo: 'tracker' }, {
      principal: owner,
      session: null,
      form: { title: 'x' },
    })
    expect(refused.status).toBe(302)
  })

  it('lets a collaborator-less user comment but not close someone else’s issue', async () => {
    const page = await render(Issue, '/olivia/tracker/issues/1', { owner: 'olivia', repo: 'tracker', number: '1' }, { principal: reader, session: sessionOf(reader) })
    expect(page.html).not.toContain('value="close"')
    const comment = await render(Issue, '/olivia/tracker/issues/1', { owner: 'olivia', repo: 'tracker', number: '1' }, {
      principal: reader,
      session: sessionOf(reader),
      form: { csrf: 'csrf-token', action: 'close', body: '' },
    })
    expect(comment.status).toBe(403)
    expect(comment.html).toContain('role="alert"')
    const after = await render(Issue, '/olivia/tracker/issues/1', { owner: 'olivia', repo: 'tracker', number: '1' })
    expect(after.html).toContain('>Open<')
  })

  it('comments, closes and reopens as the owner and lists issues by state', async () => {
    const options = { principal: owner, session: sessionOf(owner) }
    const commented = await render(Issue, '/olivia/tracker/issues/1', { owner: 'olivia', repo: 'tracker', number: '1' }, { ...options, form: { csrf: 'csrf-token', action: 'comment', body: 'On it.' } })
    expect(commented.location).toMatch(/^\/olivia\/tracker\/issues\/1#comment-\d+$/)
    await render(Issue, '/olivia/tracker/issues/1', { owner: 'olivia', repo: 'tracker', number: '1' }, { ...options, form: { csrf: 'csrf-token', action: 'close', reason: 'not_planned', body: '' } })
    const closed = await render(Issue, '/olivia/tracker/issues/1', { owner: 'olivia', repo: 'tracker', number: '1' }, options)
    expect(closed.html).toContain('On it.')
    expect(closed.html).toContain('closed this as not planned')
    expect(closed.html).toContain('value="reopen"')
    const open = await render(Issues, '/olivia/tracker/issues', { owner: 'olivia', repo: 'tracker' })
    expect(open.html).toContain('0 Open')
    expect(open.html).toContain('1 Closed')
    expect(open.html).toContain('No open issues.')
    const list = await render(Issues, '/olivia/tracker/issues?state=closed', { owner: 'olivia', repo: 'tracker' })
    expect(list.html).toContain('href="/olivia/tracker/issues/1"')
  })

  it('answers 404 for unknown issues', async () => {
    expect((await render(Issue, '/olivia/tracker/issues/99', { owner: 'olivia', repo: 'tracker', number: '99' })).status).toBe(404)
    expect((await render(Issue, '/olivia/tracker/issues/x', { owner: 'olivia', repo: 'tracker', number: 'x' })).status).toBe(404)
  })
})

describe('pull request pages', () => {
  const params = { owner: 'olivia', repo: 'tracker' }
  const options = () => ({ principal: owner, session: sessionOf(owner) })
  let number = 0

  it('opens a pull request from the form', async () => {
    const form = await render(NewPull, '/olivia/tracker/pulls/new', params, options())
    expect(form.html).toContain('<option selected>feature</option>')
    const created = await render(NewPull, '/olivia/tracker/pulls/new', params, {
      ...options(),
      form: { csrf: 'csrf-token', base: 'main', head: 'feature', title: 'Add docs', body: 'Closes #1' },
    })
    expect(created.status).toBe(303)
    number = Number(created.location!.split('/').pop())
    const list = await render(Pulls, '/olivia/tracker/pulls', params)
    expect(list.html).toContain(`href="/olivia/tracker/pull/${number}"`)
    expect((await render(Issue, `/olivia/tracker/issues/${number}`, { ...params, number: String(number) })).location).toBe(`/olivia/tracker/pull/${number}`)
  })

  it('shows commits and the diff and takes a line comment', async () => {
    const commits = await render(PullCommits, '', { ...params, number: String(number) })
    expect(commits.html).toContain('Document the tracker')
    const files = await render(PullFiles, '', { ...params, number: String(number) }, options())
    expect(files.html).toContain('Now with docs.')
    expect(files.html).toContain('data-comment-line')
    expect((await render(PullFiles, '', { ...params, number: String(number) })).html).not.toContain('data-comment-line')
    const commented = await render(PullFiles, `/olivia/tracker/pull/${number}/files`, { ...params, number: String(number) }, {
      ...options(),
      form: { csrf: 'csrf-token', path: 'README.md', line: '3', side: 'RIGHT', body: 'Nice **docs**' },
    })
    expect(commented.status).toBe(303)
    const after = await render(PullFiles, '', { ...params, number: String(number) }, options())
    expect(after.html).toContain('Nice <strong>docs</strong>')
  })

  it('takes a review and merges with the merge button', async () => {
    const page = { ...params, number: String(number) }
    const conversation = await render(Pull, '', page, options())
    expect(conversation.html).toContain('This branch can be merged')
    expect(conversation.html).toContain('value="merge"')
    expect((await render(Pull, '', page)).html).not.toContain('Merge pull request</button>')
    expect((await render(Pull, `/olivia/tracker/pull/${number}`, page, { ...options(), form: { csrf: 'csrf-token', action: 'review', event: 'COMMENT', body: 'Looks good' } })).status).toBe(303)
    const merged = await render(Pull, `/olivia/tracker/pull/${number}`, page, { ...options(), form: { csrf: 'csrf-token', action: 'merge', method: 'squash' } })
    expect(merged.status).toBe(303)
    const done = await render(Pull, '', page)
    expect(done.html).toContain('>Merged<')
    expect(done.html).toContain('Looks good')
    expect((await render(Issue, '/olivia/tracker/issues/1', { ...params, number: '1' })).html).toContain('Closed')
  })
})

describe('discussion pages', () => {
  const params = { owner: 'olivia', repo: 'tracker' }

  it('starts a Q&A discussion, replies and marks an answer', async () => {
    const form = await render(NewDiscussion, '/olivia/tracker/discussions/new', params, { principal: owner, session: sessionOf(owner) })
    const slug = /<option value="([^"]+)">[^<]*Q&amp;A/.exec(form.html)?.[1]
    expect(slug).toBeDefined()
    const created = await render(NewDiscussion, '/olivia/tracker/discussions/new', params, {
      principal: reader,
      session: sessionOf(reader),
      form: { csrf: 'csrf-token', category: slug!, title: 'How do I run it?', body: 'Asking for a friend.' },
    })
    expect(created.status).toBe(303)
    const number = created.location!.split('/').pop()!
    const page = { ...params, number }
    const answer = await render(Discussion, '', page, { principal: owner, session: sessionOf(owner), form: { csrf: 'csrf-token', action: 'comment', body: 'Run `pnpm dev`.' } })
    const commentId = /#comment-(\d+)$/.exec(answer.location!)![1]!
    await render(Discussion, '', page, { principal: reader, session: sessionOf(reader), form: { csrf: 'csrf-token', action: 'comment', parent: commentId, body: 'Thanks!' } })
    expect((await render(Discussion, '', page, { principal: reader, session: sessionOf(reader), form: { csrf: 'csrf-token', action: 'answer', comment: commentId } })).status).toBe(303)
    const shown = await render(Discussion, '', page)
    expect(shown.html).toContain('<code>pnpm dev</code>')
    expect(shown.html).toContain('Thanks!')
    expect(shown.html).toContain('>Answer<')
    const list = await render(Discussions, '/olivia/tracker/discussions', params)
    expect(list.html).toContain('How do I run it?')
    expect(list.html).toContain('Answered')
  })
})
