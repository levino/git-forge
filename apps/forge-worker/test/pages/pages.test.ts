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

const render = async (page: Parameters<AstroContainer['renderToResponse']>[0], path: string, params: Record<string, string>, principal: Principal = ANONYMOUS) => {
  const response = await container.renderToResponse(page, {
    request: new Request(`${BASE}${path}`),
    params,
    locals: { forge: forge.services, principal },
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
    expect(html).toContain('@@ -1,1 +1,2 @@')
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
