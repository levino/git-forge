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

  it('logs the CLI in with the device flow and lets plain git and git-lfs use the credential helper', async () => {
    const home = tempDir()
    const globalConfig = join(home, 'gitconfig')
    writeFileSync(globalConfig, LFS_CONFIG)
    const env = { ...process.env, ...gitEnv, HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_FORGE_CONFIG_DIR: join(home, 'git-forge') }
    const cli: ChildProcess = spawn(process.execPath, ['--no-warnings', cliMain, 'auth', 'login', dev.url], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    cli.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const exited = new Promise<number | null>((done) => cli.on('close', done))
    const deadline = Date.now() + 20_000
    while (!/code: ([A-Z]{4}-[A-Z]{4})/.test(output) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100))
    const userCode = /code: ([A-Z]{4}-[A-Z]{4})/.exec(output)![1]!
    const page = await browser.fetch(`/login/device?user_code=${userCode}`)
    expect(await page.text()).toContain(userCode)
    const approved = await browser.form('/login/device', { user_code: userCode, decision: 'approve', csrf: (await browser.session()).csrfToken })
    expect(await approved.text()).toContain('Device connected')
    expect(await exited).toBe(0)
    expect(output).toContain('Logged in to')

    const gitWith = (cwd: string, args: readonly string[]) =>
      new Promise<string>((done, fail) =>
        execFile('git', args, { cwd, env }, (error, stdout, stderr) => (error ? fail(new Error(`${error.message}\n${stderr}`)) : done(stdout))),
      )
    const remote = `${dev.url}/levin/archive.git`
    const source = tempDir()
    await gitWith(source, ['init', '-q', '-b', 'main'])
    await gitWith(source, ['lfs', 'track', '*.bin'])
    writeFileSync(join(source, 'README.md'), '# Archive\n')
    writeFileSync(join(source, 'scan.bin'), crypto.getRandomValues(new Uint8Array(4096)))
    await gitWith(source, ['add', '.'])
    await gitWith(source, ['commit', '-q', '-m', 'first'])
    await gitWith(source, ['push', '-q', remote, 'main'])
    const clone = join(tempDir(), 'clone')
    await gitWith(tempDir(), ['clone', '-q', remote, clone])
    expect(await gitWith(clone, ['log', '--format=%s'])).toBe('first\n')
    expect((await gitWith(clone, ['lfs', 'ls-files'])).trim()).toMatch(/scan\.bin$/)
    expect(await gitFails(tempDir(), ['clone', '-q', remote, 'anonymous'])).toMatch(/401|Authentication failed|could not read Username/i)

    const status = spawn(process.execPath, ['--no-warnings', cliMain, 'auth', 'status'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let statusOutput = ''
    status.stdout!.on('data', (chunk: Buffer) => (statusOutput += chunk.toString()))
    expect(await new Promise((done) => status.on('close', done))).toBe(0)
    expect(statusOutput).toContain(`${dev.url}: levin`)
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
