import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Principal } from '@git-forge/accounts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Branches from '../../src/pages/[owner]/[repo]/branches.astro'
import Blob from '../../src/pages/[owner]/[repo]/blob/[...path].astro'
import Commit from '../../src/pages/[owner]/[repo]/commit/[id].astro'
import Commits from '../../src/pages/[owner]/[repo]/commits/[...path].astro'
import RepoHome from '../../src/pages/[owner]/[repo]/index.astro'
import Tree from '../../src/pages/[owner]/[repo]/tree/[...path].astro'
import Owner from '../../src/pages/[owner]/index.astro'
import Explore from '../../src/pages/explore.astro'
import Home from '../../src/pages/index.astro'
import Login from '../../src/pages/-/login.astro'
import Settings from '../../src/pages/settings.astro'
import Notifications from '../../src/pages/notifications.astro'
import Releases from '../../src/pages/[owner]/[repo]/releases/index.astro'
import ReleaseTag from '../../src/pages/[owner]/[repo]/releases/tag/[...tag].astro'
import type { LoginPage, UserPrincipal } from '@git-forge/accounts'
import type { UiSession } from '../../src/app.ts'
import { git, tempDir } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

let forge: NodeForge
let server: RunningServer
let container: AstroContainer
let admin: Principal
let head: string
let first: string

const write = (root: string, path: string, content: string | Uint8Array) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

const ANONYMOUS: Principal = { kind: 'anonymous' }

type Extra = { readonly session?: UiSession | null; readonly loginPage?: LoginPage; readonly request?: Request; readonly services?: Partial<NodeForge['services']> }

const render = async (page: Parameters<AstroContainer['renderToResponse']>[0], path: string, params: Record<string, string>, principal: Principal = ANONYMOUS, extra: Extra = {}) => {
  const response = await container.renderToResponse(page, {
    request: extra.request ?? new Request(`${BASE}${path}`),
    params,
    locals: { forge: { ...forge.services, ...extra.services }, principal, session: extra.session ?? null, ...(extra.loginPage ? { loginPage: extra.loginPage } : {}) },
    partial: false,
  })
  return { status: response.status, location: response.headers.get('Location'), html: await response.text() }
}

beforeAll(async () => {
  forge = await nodeForge()
  server = await startServer((request) => forge.fetch(request))
  const token = await bootstrap(forge, BASE, 'alice')
  admin = (await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } })))!
  for (const [name, visibility] of [
    ['site', 'public'],
    ['secret', 'private'],
    ['empty', 'public'],
  ]) {
    expect((await call(forge, BASE, 'POST', '/api/repos', token, { owner: 'alice', name, visibility })).status).toBe(201)
  }
  const dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  write(dir, 'README.md', '# Site\n\nRead the [guide](docs/guide.md).\n\n<script>alert("x")</script>\n')
  write(dir, 'docs/guide.md', '# Guide\n')
  write(dir, 'src/main.ts', 'export const answer = 41\n')
  write(dir, 'image.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'Initial commit'])
  first = (await git(dir, ['rev-parse', 'HEAD'])).trim()
  write(dir, 'src/main.ts', 'export const answer = 42\nexport const question = "<unknown>"\n')
  await git(dir, ['commit', '-q', '-am', 'Fix the answer'])
  head = (await git(dir, ['rev-parse', 'HEAD'])).trim()
  await git(dir, ['branch', 'feature/ui'])
  await git(dir, ['tag', 'v1.0', first])
  const remote = server.url.replace('://', `://git:${token}@`)
  for (const name of ['site', 'secret']) await git(dir, ['push', '-q', `${remote}/alice/${name}.git`, 'main', 'feature/ui', 'v1.0'])
  const release = async (body: unknown) => {
    const response = await call(forge, BASE, 'POST', '/api/v3/repos/alice/site/releases', token, body)
    expect(response.status).toBe(201)
    return (await response.json()) as { id: number; upload_url: string }
  }
  const published = await release({ tag_name: 'v1.0', name: 'First release', body: '## Changes\n\n<script>x()</script>\n\nFixed [main](src/main.ts).' })
  const upload = await forge.fetch(
    new Request(`${BASE}/api/uploads/repos/alice/site/releases/${published.id}/assets?name=app.tar.gz`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/gzip', 'Content-Length': '4' },
      body: new Uint8Array([1, 2, 3, 4]),
    }),
  )
  expect(upload.status).toBe(201)
  await release({ tag_name: 'v2.0-draft', name: 'Secret plans', draft: true, target_commitish: 'main' })
  container = await AstroContainer.create()
}, 60_000)

afterAll(async () => {
  await server?.close()
})

describe('repository pages', () => {
  it('shows the file tree, the latest commit and the sanitized README', async () => {
    const { status, html } = await render(RepoHome, '/alice/site', { owner: 'alice', repo: 'site' })
    expect(status).toBe(200)
    expect(html).toContain('<title>alice/site</title>')
    expect(html).toMatch(/href="\/alice\/site\/tree\/main\/docs"[^>]*>\s*docs/)
    expect(html).toMatch(/href="\/alice\/site\/blob\/main\/src"|href="\/alice\/site\/tree\/main\/src"/)
    expect(html).toContain('Fix the answer')
    expect(html).toContain('<h1>Site</h1>')
    expect(html).toContain('href="/alice/site/blob/main/docs/guide.md"')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('https://forge.example/alice/site.git')
  })

  it('hides private repositories from anonymous visitors and shows them to the owner', async () => {
    expect((await render(RepoHome, '/alice/secret', { owner: 'alice', repo: 'secret' })).status).toBe(404)
    expect((await render(RepoHome, '/alice/secret', { owner: 'alice', repo: 'secret' }, admin)).status).toBe(200)
    expect((await render(Blob, '/alice/secret/blob/main/README.md', { owner: 'alice', repo: 'secret', path: 'main/README.md' })).status).toBe(404)
  })

  it('explains how to push into an empty repository', async () => {
    const { status, html } = await render(RepoHome, '/alice/empty', { owner: 'alice', repo: 'empty' })
    expect(status).toBe(200)
    expect(html).toContain('This repository is empty')
  })

  it('redirects clone URLs to the repository page', async () => {
    expect(await render(RepoHome, '/alice/site.git', { owner: 'alice', repo: 'site.git' })).toMatchObject({ status: 301, location: '/alice/site' })
  })

  it('browses directories on branches with slashes and tags', async () => {
    const tree = await render(Tree, '/alice/site/tree/feature/ui/src', { owner: 'alice', repo: 'site', path: 'feature/ui/src' })
    expect(tree.status).toBe(200)
    expect(tree.html).toContain('href="/alice/site/blob/feature/ui/src/main.ts"')
    const tag = await render(Tree, '/alice/site/tree/v1.0', { owner: 'alice', repo: 'site', path: 'v1.0' })
    expect(tag.html).toContain('Initial commit')
    expect((await render(Tree, '/alice/site/tree/nope', { owner: 'alice', repo: 'site', path: 'nope' })).status).toBe(404)
  })

  it('highlights source files with line anchors and escapes their content', async () => {
    const { status, html } = await render(Blob, '/alice/site/blob/main/src/main.ts', { owner: 'alice', repo: 'site', path: 'main/src/main.ts' })
    expect(status).toBe(200)
    expect(html).toContain('id="L2"')
    expect(html).toContain('--shiki-dark')
    expect(html).toContain('&lt;unknown&gt;')
    expect(html).not.toContain('"<unknown>"')
  })

  it('renders Markdown files, offers the source and redirects directories to the tree view', async () => {
    const rendered = await render(Blob, '/alice/site/blob/main/README.md', { owner: 'alice', repo: 'site', path: 'main/README.md' })
    expect(rendered.html).toContain('<h1>Site</h1>')
    expect(rendered.html).toContain('href="?plain=1"')
    const directory = await render(Blob, '/alice/site/blob/main/docs', { owner: 'alice', repo: 'site', path: 'main/docs' })
    expect(directory).toMatchObject({ status: 302, location: '/alice/site/tree/main/docs' })
  })

  it('previews binary images through the raw endpoint at the commit', async () => {
    const { html } = await render(Blob, '/alice/site/blob/main/image.png', { owner: 'alice', repo: 'site', path: 'main/image.png' })
    expect(html).toContain(`<img src="/alice/site/raw/${head}/image.png"`)
  })

  it('lists commits, branches and tags', async () => {
    const commits = await render(Commits, '/alice/site/commits', { owner: 'alice', repo: 'site' })
    expect(commits.html.indexOf('Fix the answer')).toBeLessThan(commits.html.indexOf('Initial commit'))
    const history = await render(Commits, '/alice/site/commits/main/docs', { owner: 'alice', repo: 'site', path: 'main/docs' })
    expect(history.html).toContain('Initial commit')
    expect(history.html).not.toContain('Fix the answer')
    const branches = await render(Branches, '/alice/site/branches', { owner: 'alice', repo: 'site' })
    expect(branches.html).toContain('feature/ui')
    expect(branches.html).toContain('default')
  })

  it('shows a commit with its diff', async () => {
    const { status, html } = await render(Commit, `/alice/site/commit/${head}`, { owner: 'alice', repo: 'site', id: head })
    expect(status).toBe(200)
    expect(html).toContain('Fix the answer')
    expect(html).toContain('@@ -1 +1,2 @@')
    expect(html).toContain('export const answer = 42')
    expect(html).toContain(`href="/alice/site/commit/${first}"`)
    expect((await render(Commit, '/alice/site/commit/abc', { owner: 'alice', repo: 'site', id: 'abc' })).status).toBe(404)
  })
})

describe('instance pages', () => {
  it('lists only repositories the visitor may read', async () => {
    const anonymous = await render(Explore, '/explore', {})
    expect(anonymous.html).toContain('alice/site')
    expect(anonymous.html).not.toContain('alice/secret')
    const owner = await render(Explore, '/explore', {}, admin)
    expect(owner.html).toContain('alice/secret')
  })

  it('shows the signed-in user their repositories on the home page', async () => {
    expect((await render(Home, '/', {})).html).toContain('Explore repositories')
    const home = await render(Home, '/', {}, admin)
    expect(home.html).toContain('Your repositories')
    expect(home.html).toContain('href="/alice/secret"')
  })

  it('shows profiles and 404 for unknown accounts', async () => {
    const profile = await render(Owner, '/alice', { owner: 'alice' })
    expect(profile.html).toContain('href="/alice/site"')
    expect(profile.html).not.toContain('href="/alice/secret"')
    expect((await render(Owner, '/nobody', { owner: 'nobody' })).status).toBe(404)
  })
})

describe('login and account pages', () => {
  const user = () => admin as UserPrincipal
  const session = (): UiSession => ({ principal: user(), csrf: 'csrf-token', sessionId: 'session-1' })

  it('renders the sign-in page model from the login core', async () => {
    const page = await render(Login, '/login', {}, ANONYMOUS, {
      loginPage: { kind: 'login', returnTo: '/alice/site', oidcName: 'Example ID', selfSignup: true, breakGlass: true, user: null },
    })
    expect(page.status).toBe(200)
    expect(page.html).toContain('href="/login/oidc?return_to=%2Falice%2Fsite"')
    expect(page.html).toContain('Sign in with Example ID')
    expect(page.html).toContain('data-passkey="login"')
    expect(page.html).toContain('Create with a passkey')
    expect(page.html).toContain('href="/login/break-glass"')
    expect(page.html).toContain('"returnTo":"/alice/site"')
  })

  it('escapes device data, carries the CSRF token and keeps the security headers', async () => {
    const response = await container.renderToResponse(Login, {
      request: new Request(`${BASE}/login/device`),
      locals: {
        forge: forge.services,
        principal: user(),
        session: session(),
        loginPage: { kind: 'device', userCode: 'BCDF-GHJK', device: { userCode: 'BCDF-GHJK', clientName: '<b>cli</b>', scopes: 'repo:write' }, user: { login: 'alice', csrf: 'csrf-token' } },
      },
      partial: false,
    })
    const html = await response.text()
    expect(html).toContain('&lt;b&gt;cli&lt;/b&gt;')
    expect(html).toContain('name="csrf" value="csrf-token"')
    expect(html).toContain('value="approve"')
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('uses the status of login errors and answers 404 without a page model', async () => {
    expect((await render(Login, '/login/invite/x', {}, ANONYMOUS, { loginPage: { kind: 'error', status: 404, message: 'This invite is invalid.' } })).status).toBe(404)
    expect((await render(Login, '/-/login', {})).status).toBe(404)
  })

  it('sends visitors without a session to the sign-in page', async () => {
    expect(await render(Settings, '/settings', {})).toMatchObject({ status: 302, location: '/login?return_to=%2Fsettings' })
  })

  it('creates and revokes personal access tokens', async () => {
    const post = (fields: Record<string, string | string[]>, verified: UiSession | null = session()) => {
      const body = new URLSearchParams()
      for (const [key, value] of Object.entries(fields)) for (const item of [value].flat()) body.append(key, item)
      return render(Settings, '/settings', {}, user(), {
        session: session(),
        request: new Request(`${BASE}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }),
        services: { verifySessionWrite: async () => verified },
      })
    }
    expect((await post({ action: 'create-token', name: 'laptop', scopes: 'repo:read', expires: '30' }, null)).status).toBe(403)
    expect((await post({ action: 'create-token', name: 'laptop', scopes: 'repo:root', expires: '30' })).status).toBe(400)
    const created = await post({ action: 'create-token', name: 'laptop', scopes: ['repo:read', 'repo:write'], expires: '30' })
    expect(created.status).toBe(200)
    const token = /value="(gfp_[^"]+)"/.exec(created.html)?.[1]
    expect(token).toBeDefined()
    const principal = await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } }))
    expect(principal).toMatchObject({ kind: 'user', login: 'alice' })
    const id = (await forge.services.account.listTokens(user())).find((item) => item.name === 'laptop')!.id
    expect((await post({ action: 'revoke-token', id })).html).toContain('Token revoked.')
    expect(await forge.services.authenticate(new Request(BASE, { headers: { Authorization: `Bearer ${token}` } }))).toBeNull()
    expect((await post({ action: 'revoke-token', id: 'someone-elses' })).status).toBe(400)
  })
})

describe('releases and notifications', () => {
  it('lists published releases with sanitized notes and asset downloads', async () => {
    const { status, html } = await render(Releases, '/alice/site/releases', { owner: 'alice', repo: 'site' })
    expect(status).toBe(200)
    expect(html).toContain('First release')
    expect(html).toContain('<h2>Changes</h2>')
    expect(html).not.toContain('<script>x()')
    expect(html).toContain('href="/alice/site/blob/v1.0/src/main.ts"')
    expect(html).toContain('href="/alice/site/releases/download/v1.0/app.tar.gz"')
    expect(html).toContain('4 B')
    expect(html).not.toContain('Secret plans')
  })

  it('shows drafts only to people who can write', async () => {
    const owner = await render(Releases, '/alice/site/releases', { owner: 'alice', repo: 'site' }, admin)
    expect(owner.html).toContain('Secret plans')
    expect((await render(ReleaseTag, '/alice/site/releases/tag/v2.0-draft', { owner: 'alice', repo: 'site', tag: 'v2.0-draft' })).status).toBe(404)
    const tag = await render(ReleaseTag, '/alice/site/releases/tag/v1.0', { owner: 'alice', repo: 'site', tag: 'v1.0' })
    expect(tag.status).toBe(200)
    expect(tag.html).toContain('<title>First release · alice/site</title>')
  })

  it('shows the inbox of the session user and applies its actions', async () => {
    const session: UiSession = { principal: admin as UserPrincipal, csrf: 'csrf-token', sessionId: 'session-1' }
    const done: number[] = []
    const thread = {
      id: 7, user_id: 'x', repository_id: 'r', subject_key: 'k', subject_type: 'Release', subject_title: 'First release', subject_url: null, latest_comment_url: null,
      html_url: 'https://forge.example/alice/site/releases/tag/v1.0', reason: 'subscribed', unread: 1, last_event_id: 1, updated_at: Date.now(), last_read_at: null, emailed_at: null,
      owner_login: 'alice', repository_name: 'site',
    } as const
    const inbox = {
      threads: async () => [thread],
      markRead: async () => true,
      markDone: async (_user: UserPrincipal, id: number) => (done.push(id), true),
      markAllRead: async () => 1,
    }
    expect(await render(Notifications, '/notifications', {})).toMatchObject({ status: 302 })
    const page = await render(Notifications, '/notifications', {}, admin, { session, services: { inbox } })
    expect(page.html).toContain('href="/alice/site/releases/tag/v1.0"')
    expect(page.html).toContain('Mark First release as done')
    const post = await render(Notifications, '/notifications', {}, admin, {
      session,
      services: { inbox, verifySessionWrite: async () => session },
      request: new Request(`${BASE}/notifications`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=done&id=7' }),
    })
    expect(post.status).toBe(200)
    expect(done).toEqual([7])
  })
})
