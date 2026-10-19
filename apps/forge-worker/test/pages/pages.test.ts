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
import New from '../../src/pages/new.astro'
import Import from '../../src/pages/[owner]/[repo]/import.astro'
import Notifications from '../../src/pages/notifications.astro'
import Search from '../../src/pages/search.astro'
import Blame from '../../src/pages/[owner]/[repo]/blame/[...path].astro'
import Releases from '../../src/pages/[owner]/[repo]/releases/index.astro'
import ReleaseTag from '../../src/pages/[owner]/[repo]/releases/tag/[...tag].astro'
import NewRelease from '../../src/pages/[owner]/[repo]/releases/new.astro'
import EditRelease from '../../src/pages/[owner]/[repo]/releases/edit/[...tag].astro'
import { type LoginPage, sql, type UserPrincipal } from '@git-forge/accounts'
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
let adminToken: string

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
  forge = await nodeForge({ scheduleImport: async () => {} })
  server = await startServer((request) => forge.fetch(request))
  const token = await bootstrap(forge, BASE, 'alice')
  adminToken = token
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

  it('shows the last commit of every entry from the map stored after the push', async () => {
    expect(await forge.storage.head(`repos/alice/site/cache/last-commits/${head}.json`)).not.toBeNull()
    const { html } = await render(RepoHome, '/alice/site', { owner: 'alice', repo: 'site' })
    expect(html).toMatch(new RegExp(`href="/alice/site/commit/${first}"[^>]*>\\s*Initial commit`))
    expect(html).toMatch(new RegExp(`href="/alice/site/commit/${head}"[^>]*>\\s*Fix the answer`))
    const tag = await render(Tree, '/alice/site/tree/v1.0', { owner: 'alice', repo: 'site', path: 'v1.0' })
    expect(tag.html).toContain('Initial commit')
    expect(tag.html).not.toMatch(new RegExp(`<td[^>]*>\\s*<a href="/alice/site/commit/${first}"`))
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
    expect(html).toMatch(/<span style="--shiki-light:[^"]+">export<\/span>/)
    expect(html.replace(/<[^>]+>/g, '')).toContain('export const answer = 42')
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

  it('lists from stored columns, sorted by last commit or name', async () => {
    const rows = await forge.db.all<{ name: string; default_branch: string | null; last_commit_at: number | null }>(sql('SELECT name, default_branch, last_commit_at FROM repositories ORDER BY name'))
    expect(rows.find((row) => row.name === 'site')).toMatchObject({ default_branch: 'main', last_commit_at: expect.any(Number) })
    const order = (html: string) => [...html.matchAll(/href="\/alice\/(site|secret|empty)"/g)].map((match) => match[1])
    expect(order((await render(Explore, '/explore', {}, admin)).html)).toEqual(['secret', 'site', 'empty'])
    const byName = await render(Explore, '/explore?sort=name', {}, admin)
    expect(order(byName.html)).toEqual(['empty', 'secret', 'site'])
    expect(byName.html).toContain('href="?sort=name"')
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
      loginPage: { kind: 'login', returnTo: '/alice/site', oidcName: 'Example ID', selfSignup: true, breakGlass: true, passkeys: true, user: null },
    })
    expect(page.status).toBe(200)
    expect(page.html).toContain('href="/login/oidc?return_to=%2Falice%2Fsite"')
    expect(page.html).toContain('Sign in with Example ID')
    expect(page.html).toContain('data-passkey="login"')
    expect(page.html).toContain('Create with a passkey')
    expect(page.html).toContain('href="/login/break-glass"')
    expect(page.html).toContain('"returnTo":"/alice/site"')
  })

  it('hides every passkey control and the ceremony script when passkeys are disabled', async () => {
    const signIn = await render(Login, '/login', {}, ANONYMOUS, {
      loginPage: { kind: 'login', returnTo: '/', oidcName: 'Example ID', selfSignup: true, breakGlass: true, passkeys: false, user: null },
    })
    expect(signIn.html).toContain('Sign in with Example ID')
    expect(signIn.html).toContain('href="/login/break-glass"')
    expect(signIn.html).not.toContain('data-passkey')
    expect(signIn.html).not.toContain('login-config')
    const signedIn = await render(Login, '/login', {}, user(), {
      session: session(),
      loginPage: { kind: 'login', returnTo: '/', oidcName: null, selfSignup: false, breakGlass: false, passkeys: false, user: { login: 'alice', csrf: 'csrf-token' } },
    })
    expect(signedIn.html).toContain('Signed in as')
    expect(signedIn.html).not.toContain('data-passkey')
    const invite = await render(Login, '/login/invite/abc', {}, ANONYMOUS, {
      loginPage: { kind: 'invite', code: 'abc', login: 'bob', existingUser: false, oidcName: 'Example ID', passkeys: false },
    })
    expect(invite.html).toContain('href="/login/oidc?invite=abc"')
    expect(invite.html).not.toContain('data-passkey')
    expect(invite.html).not.toContain('login-config')
    const enabled = await render(Login, '/login/invite/abc', {}, ANONYMOUS, {
      loginPage: { kind: 'invite', code: 'abc', login: 'bob', existingUser: false, oidcName: 'Example ID', passkeys: true },
    })
    expect(enabled.html).toContain('data-passkey="register"')
    const settings = await render(Settings, '/settings', {}, user(), {
      session: session(),
      services: { loginMethods: async () => ({ oidcName: null, passkeys: false }) },
    })
    expect(settings.status).toBe(200)
    expect(settings.html).not.toContain('data-passkey')
    expect(settings.html).not.toContain('id="passkeys"')
    expect((await render(Settings, '/settings', {}, user(), { session: session() })).html).toContain('data-passkey="register"')
  })

  it('escapes device data, carries the CSRF token and keeps the security headers', async () => {
    const response = await container.renderToResponse(Login, {
      request: new Request(`${BASE}/login/device`),
      locals: {
        forge: forge.services,
        principal: user(),
        session: session(),
        loginPage: {
          kind: 'device',
          userCode: 'BCDF-GHJK',
          device: { userCode: 'BCDF-GHJK', clientName: '<b>cli</b>', clientHost: '<i>box</i>', requestIp: '203.0.113.9', requestedAt: Date.UTC(2026, 0, 2, 3, 4, 5), scope: 'repo:write' },
          user: { login: 'alice', csrf: 'csrf-token' },
          instance: 'forge.example',
          viewerIp: '198.51.100.1',
        },
      },
      partial: false,
    })
    const html = await response.text()
    expect(html).toContain('&lt;b&gt;cli&lt;/b&gt;')
    expect(html).toContain('&lt;i&gt;box&lt;/i&gt;')
    expect(html).toContain('203.0.113.9')
    expect(html).toContain('this browser: 198.51.100.1')
    expect(html).toContain('2026-01-02 03:04:05 UTC')
    expect(html).toContain('Only approve a request you started yourself')
    expect(html).toContain('name="csrf" value="csrf-token"')
    expect(html).toContain('value="approve"')
    expect(html).toMatch(/type="radio"[^>]*name="scope"[^>]*value="repo:read"/)
    expect(html).toContain('write (includes read)')
    expect(html).not.toContain('value="repo:admin"')
    expect(response.headers.get('Content-Security-Policy')).toContain("form-action 'self';")
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('renders the command line consent with loopback form action and the code page with a copy button', async () => {
    const consent = await container.renderToResponse(Login, {
      request: new Request(`${BASE}/login/cli/abcdefghijklmnopqrstuv`),
      locals: {
        forge: forge.services,
        principal: user(),
        session: session(),
        loginPage: {
          kind: 'cli',
          user: { login: 'alice', csrf: 'csrf-token' },
          instance: 'forge.example',
          request: {
            id: 'abcdefghijklmnopqrstuv',
            clientName: 'git forge auth login',
            clientHost: 'laptop',
            requestIp: '203.0.113.9',
            requestedAt: 0,
            redirect: 'loopback',
            redirectUri: 'http://127.0.0.1:4000/callback',
            scope: 'repo:admin',
          },
        },
      },
      partial: false,
    })
    const html = await consent.text()
    expect(html).toContain('action="/login/cli/abcdefghijklmnopqrstuv"')
    expect(html).toContain('admin (includes write)')
    expect(html).toContain('http://127.0.0.1:4000/callback')
    expect(consent.headers.get('Content-Security-Policy')).toContain("form-action 'self' http://127.0.0.1:* http://localhost:*")
    const code = await render(Login, '/login/cli/abcdefghijklmnopqrstuv', {}, user(), { loginPage: { kind: 'cli-code', code: 'gfc_abc', expiresAt: 0 } })
    expect(code.html).toContain('value="gfc_abc"')
    expect(code.html).toContain('data-copy="cli-code"')
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
    expect((await post({ action: 'create-token', name: 'laptop', scope: 'repo:read', expires: '30' }, null)).status).toBe(403)
    expect((await post({ action: 'create-token', name: 'laptop', scope: 'repo:root', expires: '30' })).status).toBe(400)
    const form = await render(Settings, '/settings', {}, user(), { session: session() })
    expect(form.html).toMatch(/type="radio"[^>]*name="scope"[^>]*value="repo:write"[^>]*checked/)
    expect(form.html).toContain('admin (includes write)')
    expect(form.html).not.toContain('type="checkbox"')
    const created = await post({ action: 'create-token', name: 'laptop', scope: 'repo:write', expires: '30' })
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

describe('new repository page', () => {
  const user = () => admin as UserPrincipal
  const session = (): UiSession => ({ principal: user(), csrf: 'csrf-token', sessionId: 'session-1' })
  const post = (fields: Record<string, string>, verified: UiSession | null = session()) =>
    render(New, '/new', {}, user(), {
      session: session(),
      request: new Request(`${BASE}/new`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }),
      services: { verifySessionWrite: async () => verified },
    })

  it('sends visitors without a session to the sign-in page', async () => {
    expect(await render(New, '/new', {})).toMatchObject({ status: 302, location: '/login?return_to=%2Fnew' })
  })

  it('offers the accounts the user may create in and the import form', async () => {
    const page = await render(New, '/new', {}, user(), { session: session() })
    expect(page.status).toBe(200)
    expect(page.html).toContain('<option value="alice" selected')
    expect(page.html).toContain('name="csrf" value="csrf-token"')
    expect(page.html).toContain('value="import"')
    expect(page.html).toContain('Also import issues, pull requests and releases')
    expect(page.html).toContain('href="/new"')
    const plain = await render(New, '/new', {}, user(), { session: session(), services: { repositories: { ...forge.services.repositories, importsEnabled: false } } })
    expect(plain.html).toContain('Imports are not available')
  })

  it('creates a repository from the session and redirects to its empty page', async () => {
    expect((await post({ action: 'create', owner: 'alice', name: 'fresh' }, null)).status).toBe(403)
    const created = await post({ action: 'create', owner: 'alice', name: 'fresh', visibility: 'private', defaultBranch: 'trunk' })
    expect(created).toMatchObject({ status: 303, location: '/alice/fresh' })
    expect(await forge.services.store.findRepository('alice', 'fresh')).toMatchObject({ visibility: 'private' })
    const home = await render(RepoHome, '/alice/fresh', { owner: 'alice', repo: 'fresh' }, admin)
    expect(home.html).toContain('This repository is empty')
    expect(home.html).toContain('https://forge.example/alice/fresh.git')
    expect(home.html).toContain('git push -u origin trunk')
    expect((await render(RepoHome, '/alice/fresh', { owner: 'alice', repo: 'fresh' })).status).toBe(404)
    const again = await post({ action: 'create', owner: 'alice', name: 'fresh' })
    expect(again.status).toBe(409)
    expect(again.html).toContain('alice/fresh already exists')
    expect((await post({ action: 'create', owner: 'nobody', name: 'x' })).status).toBe(404)
    expect((await post({ action: 'create', owner: 'alice', name: 'bad name' })).status).toBe(400)
  })

  it('queues mirrors of a GitHub account from the form', async () => {
    expect((await render(New, '/new', {}, user(), { session: session() })).html).toContain('value="github"')
    const unavailable = await post({ action: 'github', account: 'levino', owner: 'alice' })
    expect(unavailable.status).toBe(503)
    expect(unavailable.html).toContain('bulk mirroring needs a job queue')
    const inputs: unknown[] = []
    const repositories = { ...forge.services.repositories, mirrorGitHub: async (_user: unknown, input: unknown) => (inputs.push(input), { owner: 'alice', account: 'levino', queued: [], skipped: [] }) }
    const queued = await render(New, '/new', {}, user(), {
      session: session(),
      request: new Request(`${BASE}/new`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'github', account: 'levino', owner: 'alice', token: 'ghp_x', archived: 'on', webhook: 'on' }) }),
      services: { verifySessionWrite: async () => session(), repositories },
    })
    expect(queued).toMatchObject({ status: 303, location: '/alice' })
    expect(inputs).toEqual([{ account: 'levino', owner: 'alice', token: 'ghp_x', forks: false, archived: true, webhook: true }])
    expect((await post({ action: 'github', account: '', owner: 'alice' })).status).toBe(400)
  })

  it('starts an import and shows its status to repository admins', async () => {
    const started = await post({ action: 'import', owner: 'alice', name: 'imported', url: 'https://example.org/up.git', token: 'secret', lfs: 'on', visibility: 'public' })
    expect(started).toMatchObject({ status: 303, location: '/alice/imported/import' })
    expect((await post({ action: 'import', owner: 'alice', name: 'other', url: 'https://user:pw@example.org/up.git' })).status).toBe(400)
    const status = await render(Import, '/alice/imported/import', { owner: 'alice', repo: 'imported' }, admin, { session: session() })
    expect(status.status).toBe(200)
    expect(status.html).toContain('Listing upstream refs')
    expect(status.html).toContain('https://example.org/up.git')
    expect(status.html).toContain('http-equiv="refresh"')
    expect(status.html).not.toContain('secret')
    const empty = await render(RepoHome, '/alice/imported', { owner: 'alice', repo: 'imported' }, admin, { session: session() })
    expect(empty.html).toContain('href="/alice/imported/import"')
    expect((await render(RepoHome, '/alice/fresh', { owner: 'alice', repo: 'fresh' }, admin, { session: session() })).html).not.toContain('View the import status')
    expect((await render(Import, '/alice/site/import', { owner: 'alice', repo: 'site' }, admin, { session: session() })).status).toBe(404)
    expect((await render(Import, '/alice/imported/import', { owner: 'alice', repo: 'imported' })).status).toBe(302)
    expect((await post({ action: 'import', owner: 'alice', name: 'gh', url: 'https://example.org/up.git', metadata: 'on' })).status).toBe(400)
    expect(await post({ action: 'import', owner: 'alice', name: 'gh', url: 'https://github.com/acme/site', metadata: 'on' })).toMatchObject({ status: 303 })
    const metadata = await render(Import, '/alice/gh/import', { owner: 'alice', repo: 'gh' }, admin, { session: session() })
    expect(metadata.html).toContain('Issues, pull requests, releases')
    expect(metadata.html).toContain('Waiting for the Git import: nothing yet')
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

  it('links source archives, the latest release and release editing for writers', async () => {
    const home = await render(RepoHome, '/alice/site', { owner: 'alice', repo: 'site' })
    expect(home.html).toMatch(/href="\/alice\/site\/releases\/tag\/v1.0"[^>]*aria-label="Latest release"/)
    const list = await render(Releases, '/alice/site/releases', { owner: 'alice', repo: 'site' })
    expect(list.html).toContain('href="/alice/site/archive/refs/tags/v1.0.zip"')
    expect(list.html).toContain('href="/alice/site/archive/refs/tags/v1.0.tar.gz"')
    expect(list.html).toContain('Latest')
    expect(list.html).not.toContain('Draft a new release')
    expect(list.html).not.toContain('/alice/site/releases/edit/')
    const session: UiSession = { principal: admin as UserPrincipal, csrf: 'csrf-token', sessionId: 'session-1' }
    const writer = await render(Releases, '/alice/site/releases', { owner: 'alice', repo: 'site' }, admin, { session })
    expect(writer.html).toContain('href="/alice/site/releases/new"')
    expect(writer.html).toContain('href="/alice/site/releases/edit/v1.0"')
    const zip = await forge.fetch(new Request(`${BASE}/alice/site/archive/refs/tags/v1.0.zip`))
    expect(zip.status).toBe(200)
    expect(zip.headers.get('Content-Type')).toBe('application/zip')
    expect((await forge.fetch(new Request(`${BASE}/alice/secret/archive/refs/tags/v1.0.tar.gz`))).status).toBe(401)
  })

  it('creates, generates notes for, edits and deletes releases through the forms', async () => {
    const session: UiSession = { principal: admin as UserPrincipal, csrf: 'csrf-token', sessionId: 'session-1' }
    const post = (path: string, form: Record<string, string>) => ({
      session,
      request: new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }),
      services: { verifySessionWrite: async () => session },
    })
    expect((await render(NewRelease, '/alice/site/releases/new', { owner: 'alice', repo: 'site' })).location).toBe('/login?return_to=%2Falice%2Fsite%2Freleases%2Fnew')
    const blank = await render(NewRelease, '/alice/site/releases/new', { owner: 'alice', repo: 'site' }, admin, { session })
    expect(blank.html).toContain('Generate release notes')
    expect(blank.html).toContain('<option value="main" selected')
    const generated = await render(NewRelease, '/alice/site/releases/new', { owner: 'alice', repo: 'site' }, admin, post('/alice/site/releases/new', { csrf: 'x', tag_name: 'v3.0', target_commitish: 'main', name: '', body: '', intent: 'generate' }))
    expect(generated.status).toBe(200)
    expect(generated.html).toContain('**Full Changelog**: https://forge.example/alice/site/compare/v1.0...v3.0')
    const created = await render(NewRelease, '/alice/site/releases/new', { owner: 'alice', repo: 'site' }, admin, post('/alice/site/releases/new', { csrf: 'x', tag_name: 'v3.0', target_commitish: 'main', name: 'Third', body: 'Notes', intent: 'save', prerelease: 'on' }))
    expect(created.status).toBe(303)
    expect(created.location).toBe('/alice/site/releases/tag/v3.0')
    const duplicate = await render(NewRelease, '/alice/site/releases/new', { owner: 'alice', repo: 'site' }, admin, post('/alice/site/releases/new', { csrf: 'x', tag_name: 'v3.0', intent: 'save' }))
    expect(duplicate.status).toBe(422)
    expect(duplicate.html).toContain('a release for tag v3.0 already exists')
    const edit = await render(EditRelease, '/alice/site/releases/edit/v3.0', { owner: 'alice', repo: 'site', tag: 'v3.0' }, admin, { session })
    expect(edit.html).toContain('value="Third"')
    expect(edit.html).toContain('data-upload="/api/uploads/repos/alice/site/releases/')
    const updated = await render(EditRelease, '/alice/site/releases/edit/v3.0', { owner: 'alice', repo: 'site', tag: 'v3.0' }, admin, post('/alice/site/releases/edit/v3.0', { csrf: 'x', tag_name: 'v3.0', target_commitish: 'main', name: 'Third, renamed', body: 'Notes', intent: 'save' }))
    expect(updated.location).toBe('/alice/site/releases/tag/v3.0')
    const tag = await render(ReleaseTag, '/alice/site/releases/tag/v3.0', { owner: 'alice', repo: 'site', tag: 'v3.0' })
    expect(tag.html).toContain('Third, renamed')
    expect(tag.html).not.toContain('Pre-release')
    const removed = await render(EditRelease, '/alice/site/releases/edit/v3.0', { owner: 'alice', repo: 'site', tag: 'v3.0' }, admin, post('/alice/site/releases/edit/v3.0', { csrf: 'x', tag_name: 'v3.0', intent: 'delete' }))
    expect(removed.location).toBe('/alice/site/releases')
    expect((await render(ReleaseTag, '/alice/site/releases/tag/v3.0', { owner: 'alice', repo: 'site', tag: 'v3.0' })).status).toBe(404)
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

describe('blame and search pages', () => {
  it('blames every line of a file with bounded history', async () => {
    const { status, html } = await render(Blame, '/alice/site/blame/main/src/main.ts', { owner: 'alice', repo: 'site', path: 'main/src/main.ts' })
    expect(status).toBe(200)
    expect(html).toContain('Fix the answer')
    expect(html).toContain('href="#L2"')
    expect(html).toContain('--shiki-light')
    expect((await render(Blame, '/alice/site/blame/main/README.md', { owner: 'alice', repo: 'site', path: 'main/README.md' })).html).toContain('Initial commit')
    expect((await render(Blame, '/alice/secret/blame/main/README.md', { owner: 'alice', repo: 'secret', path: 'main/README.md' })).status).toBe(404)
    expect((await render(Blame, '/alice/site/blame/main/image.png', { owner: 'alice', repo: 'site', path: 'main/image.png' })).status).toBe(404)
  })

  it('searches repositories, issues and users without leaking private repositories', async () => {
    for (const repo of ['site', 'secret']) {
      expect((await call(forge, BASE, 'POST', `/api/v3/repos/alice/${repo}/issues`, adminToken, { title: `Zebra in ${repo}`, body: 'Stripes everywhere' })).status).toBe(201)
    }
    const titles = (html: string) => [...html.matchAll(/>\s*(Zebra in \w+)\s*</g)].map((match) => match[1]).sort()
    expect(titles((await render(Search, '/search?q=zebra&type=issues', {})).html)).toEqual(['Zebra in site'])
    expect(titles((await render(Search, '/search?q=stripes&type=issues', {}, admin)).html)).toEqual(['Zebra in secret', 'Zebra in site'])
    expect((await render(Search, '/search?q=secret', {})).html).toContain('No repositories match.')
    expect((await render(Search, '/search?q=secret', {}, admin)).html).toContain('href="/alice/secret"')
    expect((await render(Search, '/search?q=ali&type=users', {})).html).toContain('href="/alice"')
    const api = await call(forge, BASE, 'GET', '/api/v3/search/issues?q=zebra')
    expect(api.status).toBe(200)
    const body = (await api.json()) as { total_count: number; items: { title: string; html_url: string; user: { login: string } }[] }
    expect(body).toMatchObject({ total_count: 1, items: [{ title: 'Zebra in site', html_url: 'https://forge.example/alice/site/issues/1', user: { login: 'alice' } }] })
    const repos = (await (await call(forge, BASE, 'GET', '/api/search?type=repositories&q=s', adminToken)).json()) as { total_count: number }
    expect(repos.total_count).toBe(2)
    const listed = (await (await call(forge, BASE, 'GET', '/api/repos?sort=name')).json()) as { items: { full_name: string }[] }
    const names = listed.items.map((item) => item.full_name)
    expect(names).toEqual([...names].sort())
    expect(names).toContain('alice/site')
    expect(names).not.toContain('alice/secret')
  })
})

describe('partial visibility', () => {
  it('shows anonymous visitors only the visible paths of a visible branch', async () => {
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/secret/visibility', adminToken, { refs: 'refs/heads/main', path: 'docs', audience: 'public' })).status).toBe(201)
    const at = (path: string) => ({ owner: 'alice', repo: 'secret', path })
    const home = await render(RepoHome, '/alice/secret', { owner: 'alice', repo: 'secret' })
    expect(home.status).toBe(200)
    expect(home.html).toContain('href="/alice/secret/tree/main/docs"')
    expect(home.html).not.toContain('/alice/secret/tree/main/src')
    expect(home.html).not.toContain('README.md')
    expect(home.html).not.toContain('href="/alice/secret/issues"')
    expect((await render(Blob, '/alice/secret/blob/main/docs/guide.md', at('main/docs/guide.md'))).status).toBe(200)
    expect((await render(Blob, '/alice/secret/blob/main/README.md', at('main/README.md'))).status).toBe(404)
    expect((await render(Tree, '/alice/secret/tree/main/src', at('main/src'))).status).toBe(404)
    expect((await render(Tree, '/alice/secret/tree/feature/ui/docs', at('feature/ui/docs'))).status).toBe(404)
    expect((await render(Blame, '/alice/secret/blame/main/src/main.ts', at('main/src/main.ts'))).status).toBe(404)
    expect((await render(Commits, '/alice/secret/commits/main/docs', at('main/docs'))).html).toContain('Initial commit')
    expect((await render(Commits, '/alice/secret/commits/main', at('main'))).html).not.toContain('Fix the answer')
    const initial = await render(Commit, `/alice/secret/commit/${first}`, { owner: 'alice', repo: 'secret', id: first })
    expect(initial.html).toContain('docs/guide.md')
    expect(initial.html).not.toContain('src/main.ts')
    expect((await render(Commit, `/alice/secret/commit/${head}`, { owner: 'alice', repo: 'secret', id: head })).html).not.toContain('Fix the answer')
    const branches = await render(Branches, '/alice/secret/branches', { owner: 'alice', repo: 'secret' })
    expect(branches.html).not.toContain('feature/ui')
    expect(branches.html).not.toContain('Fix the answer')
    expect((await render(Releases, '/alice/secret/releases', { owner: 'alice', repo: 'secret' })).status).toBe(404)
    expect((await render(RepoHome, '/alice/secret', { owner: 'alice', repo: 'secret' }, admin)).html).toContain('README.md')
  })
})
