import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generateSigningKey, type PrivateJwk, signBreakGlassToken } from '@git-forge/accounts'
import { createMockOidc, type MockOidc } from '@git-forge/accounts/test/support/mock-oidc.ts'
import { createSoftAuthenticator } from '@git-forge/accounts/test/support/soft-authenticator.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitEnv, gitFails, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const BOOTSTRAP_TOKEN = `e2e-${crypto.randomUUID()}`

const cliMain = resolve(import.meta.dirname, '../../../../packages/cli/src/main.ts')

let dev: WranglerDev
let oidc: MockOidc
let oidcServer: RunningServer
let breakGlassKey: PrivateJwk
let admin: string

class Browser {
  readonly cookies = new Map<string, string>()

  async fetch(path: string, init: RequestInit & { csrf?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.cookies.size > 0) headers.set('Cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '))
    if (init.csrf) headers.set('X-CSRF-Token', init.csrf)
    if ((init.method ?? 'GET') !== 'GET') headers.set('Origin', dev.url)
    const response = await fetch(new URL(path, dev.url), { ...init, headers, redirect: 'manual' })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split('; ')
      const [name, value] = pair!.split('=') as [string, string]
      if (attributes.includes('Max-Age=0')) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }

  form(path: string, fields: Record<string, string>) {
    return this.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
  }

  json(path: string, body: unknown, csrf?: string) {
    return this.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(csrf ? { csrf } : {}) })
  }

  async session(): Promise<{ login: string; method: string; csrfToken: string; admin: boolean }> {
    return (await (await this.fetch('/api/session')).json()) as { login: string; method: string; csrfToken: string; admin: boolean }
  }
}

const oidcLogin = async (browser: Browser, path: string): Promise<Response> => {
  const start = await browser.fetch(path)
  expect(start.status).toBe(303)
  const authorize = await fetch(start.headers.get('Location')!, { redirect: 'manual' })
  expect(authorize.status).toBe(302)
  const callback = new URL(authorize.headers.get('Location')!)
  expect(callback.origin).toBe(dev.url)
  return browser.fetch(callback.pathname + callback.search)
}

const LFS_CONFIG = `[filter "lfs"]
\tprocess = git-lfs filter-process
\tsmudge = git-lfs smudge -- %f
\tclean = git-lfs clean -- %f
\trequired = true
[lfs]
\tlocksverify = false
`

beforeAll(async () => {
  oidc = await createMockOidc({ alg: 'ES256' })
  oidcServer = await startServer((request) => oidc.handle(request))
  oidc.issuer = oidcServer.url
  oidc.user = { sub: '2482983', preferred_username: 'levin@dorf.example', email: 'levin@dorf.example', email_verified: true, name: 'Levin' }
  breakGlassKey = (await generateSigningKey()).privateJwk
  dev = await startWranglerDev({
    vars: {
      BOOTSTRAP_TOKEN,
      OIDC_ISSUER: oidcServer.url,
      OIDC_CLIENT_ID: oidc.clientId,
      OIDC_CLIENT_SECRET: oidc.clientSecret,
      OIDC_NAME: 'Dorf-ID',
      SELF_SIGNUP: 'false',
      BREAK_GLASS_PUBLIC_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: breakGlassKey.x }),
    },
  })
  const response = await fetch(`${dev.url}/api/bootstrap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'levin' }),
  })
  admin = ((await response.json()) as { token: string }).token
}, 90_000)

afterAll(async () => {
  await dev?.stop()
  await oidcServer?.close()
})

const adminApi = (path: string, body: unknown) =>
  fetch(`${dev.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const browser = new Browser()

describe('interactive login on wrangler dev', () => {
  it('refuses an unknown OIDC identity, then links it to the admin through an invite', async () => {
    const refused = await oidcLogin(new Browser(), '/login/oidc')
    expect(refused.status).toBe(403)
    const invite = (await (await adminApi('/api/admin/invites', { user: 'levin' })).json()) as { code: string; url: string }
    expect(invite.url).toBe(`${dev.url}/login/invite/${invite.code}`)
    expect(await (await browser.fetch(`/login/invite/${invite.code}`)).text()).toContain('Continue with Dorf-ID')
    const linked = await oidcLogin(browser, `/login/oidc?invite=${invite.code}`)
    expect(linked.status).toBe(303)
    expect(browser.cookies.has('gf_session')).toBe(true)
    expect(await browser.session()).toMatchObject({ login: 'levin', method: 'oidc', admin: true })
    const again = new Browser()
    expect((await oidcLogin(again, '/login/oidc?return_to=/levin')).headers.get('Location')).toBe('/levin')
    expect(await again.session()).toMatchObject({ login: 'levin' })
  })

  it('creates a repository from the browser session with a CSRF token', async () => {
    const body = { owner: 'levin', name: 'archive', visibility: 'private' }
    expect((await browser.json('/api/repos', body)).status).toBe(403)
    expect((await browser.json('/api/repos', body, (await browser.session()).csrfToken)).status).toBe(201)
  })

  const cliEnv = () => {
    const home = tempDir()
    const globalConfig = join(home, 'gitconfig')
    writeFileSync(globalConfig, LFS_CONFIG)
    return { ...process.env, ...gitEnv, HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_FORGE_CONFIG_DIR: join(home, 'git-forge'), BROWSER: 'none' }
  }

  const runCli = (args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string) => {
    const child: ChildProcess = spawn(process.execPath, ['--no-warnings', cliMain, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    const exited = new Promise<number | null>((done) => child.on('close', done))
    const waitFor = async (pattern: RegExp): Promise<RegExpExecArray> => {
      const deadline = Date.now() + 20_000
      while (!pattern.test(stderr) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100))
      const match = pattern.exec(stderr)
      if (!match) throw new Error(`CLI did not print ${pattern}: ${stderr}`)
      return match
    }
    return { child, exited, waitFor, output: () => ({ stderr, stdout }) }
  }

  const linkPattern = (path: string) => new RegExp(`(${dev.url.replace(/[.]/g, '\\.')}${path}\\S*)`)

  const gitWith = (cwd: string, args: readonly string[], env: NodeJS.ProcessEnv) =>
    new Promise<string>((done, fail) => execFile('git', args, { cwd, env }, (error, stdout, stderr) => (error ? fail(new Error(`${error.message}\n${stderr}`)) : done(stdout))))

  it('logs the CLI in by pasting the code from the browser, creates a repository and pushes with plain git and git-lfs', async () => {
    const env = cliEnv()
    const login = runCli(['auth', 'login', dev.url, '--paste', '--scopes', 'repo:admin'], env)
    const link = new URL((await login.waitFor(linkPattern('/login/cli/')))[1]!)
    expect(link.pathname).toMatch(/^\/login\/cli\/[A-Za-z0-9_-]{22}$/)
    expect(link.search).toBe('')
    const consent = await (await browser.fetch(link.pathname)).text()
    expect(consent).toContain('admin (includes write)')
    expect(consent).toContain('Only approve a request you started yourself')
    const approved = await (await browser.form(link.pathname, { decision: 'approve', scope: 'repo:admin', csrf: (await browser.session()).csrfToken })).text()
    const code = /value="(gfc_[A-Za-z0-9_-]+)"/.exec(approved)![1]!
    login.child.stdin!.end(`${code}\n`)
    expect(await login.exited).toBe(0)
    expect(login.output().stderr).toContain('Logged in to')

    const source = tempDir()
    await gitWith(source, ['init', '-q', '-b', 'main'], env)
    const create = runCli(['repo', 'create', 'levin/from-cli', '--private', '--remote', 'origin'], env, source)
    expect(await create.exited).toBe(0)
    const remote = `${dev.url}/levin/from-cli.git`
    expect(create.output().stdout.trim()).toBe(remote)
    expect((await gitWith(source, ['remote', 'get-url', 'origin'], env)).trim()).toBe(remote)

    await gitWith(source, ['lfs', 'track', '*.bin'], env)
    writeFileSync(join(source, 'README.md'), '# From the CLI\n')
    writeFileSync(join(source, 'scan.bin'), crypto.getRandomValues(new Uint8Array(4096)))
    await gitWith(source, ['add', '.'], env)
    await gitWith(source, ['commit', '-q', '-m', 'first'], env)
    await gitWith(source, ['push', '-q', 'origin', 'main'], env)
    const clone = join(tempDir(), 'clone')
    await gitWith(tempDir(), ['clone', '-q', remote, clone], env)
    expect(await gitWith(clone, ['log', '--format=%s'], env)).toBe('first\n')
    expect((await gitWith(clone, ['lfs', 'ls-files'], env)).trim()).toMatch(/scan\.bin$/)
    expect(await gitFails(tempDir(), ['clone', '-q', remote, 'anonymous'])).toMatch(/401|Authentication failed|could not read Username/i)

    const status = runCli(['auth', 'status'], env)
    expect(await status.exited).toBe(0)
    expect(status.output().stdout).toContain(`${dev.url}: levin`)
  }, 60_000)

  it('logs the CLI in through a loopback redirect', async () => {
    const env = cliEnv()
    const login = runCli(['auth', 'login', dev.url, '--browser-redirect', '--no-setup-git'], env)
    const link = new URL((await login.waitFor(linkPattern('/login/cli/')))[1]!)
    const approved = await browser.form(link.pathname, { decision: 'approve', csrf: (await browser.session()).csrfToken })
    expect(approved.status).toBe(303)
    const callback = new URL(approved.headers.get('Location')!)
    expect(callback.hostname).toBe('127.0.0.1')
    expect(await (await fetch(callback)).text()).toContain('Logged in')
    expect(await login.exited).toBe(0)
    expect(login.output().stderr).toContain('(repo:write)')
    const repo = runCli(['repo', 'create', 'levin/needs-admin', '--host', dev.url], env)
    expect(await repo.exited).toBe(1)
    expect(repo.output().stderr).toContain('--scopes repo:admin')
  }, 60_000)

  it('logs the CLI in with the device flow through the complete verification link', async () => {
    const env = cliEnv()
    const login = runCli(['auth', 'login', dev.url, '--device', '--scopes', 'repo:read', '--no-setup-git'], env)
    const link = new URL((await login.waitFor(linkPattern('/login/device\\?user_code=')))[1]!)
    const page = await (await browser.fetch(`${link.pathname}${link.search}`)).text()
    expect(page).toContain(link.searchParams.get('user_code')!)
    expect(page).toContain('Requested from')
    const approved = await browser.form('/login/device', { user_code: link.searchParams.get('user_code')!, decision: 'approve', scope: 'repo:admin', csrf: (await browser.session()).csrfToken })
    expect(await approved.text()).toContain('Device connected')
    expect(await login.exited).toBe(0)
    expect(login.output().stderr).toContain('(repo:read)')
  }, 60_000)

  it('signs up with a passkey from an invite, without OIDC', async () => {
    const invite = (await (await adminApi('/api/admin/invites', { login: 'anna' })).json()) as { code: string }
    const authenticator = await createSoftAuthenticator({ origin: dev.url })
    const anna = new Browser()
    const options = (await (await anna.json('/login/passkey/register/options', { invite: invite.code })).json()) as { handle: string; publicKey: { challenge: string; user: { id: string } } }
    const registered = await anna.json('/login/passkey/register', { handle: options.handle, credential: await authenticator.create(options.publicKey) })
    expect(registered.status).toBe(201)
    const fresh = new Browser()
    const login = (await (await fresh.json('/login/passkey/options', {})).json()) as { handle: string; publicKey: { challenge: string } }
    expect((await fresh.json('/login/passkey', { handle: login.handle, credential: await authenticator.get(login.publicKey) })).status).toBe(200)
    expect(await fresh.session()).toMatchObject({ login: 'anna', method: 'passkey', admin: false })
  })

  it('opens an admin session with the offline break-glass key', async () => {
    const rescue = new Browser()
    const token = await signBreakGlassToken({ privateJwk: breakGlassKey, audience: dev.url, login: 'levin' })
    expect((await rescue.form('/login/break-glass', { token })).status).toBe(303)
    expect(await rescue.session()).toMatchObject({ login: 'levin', method: 'break-glass', admin: true })
    expect(await (await new Browser().form('/login/break-glass', { token })).text()).toContain('already used')
  })
})
