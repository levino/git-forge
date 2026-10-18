import { createAccountsStore } from '@git-forge/accounts'
import { base64UrlEncode, generateSigningKey, pkceChallenge, type PrivateJwk, signBreakGlassToken } from '@git-forge/accounts'
import { createMockOidc, type MockOidc } from '@git-forge/accounts/test/support/mock-oidc.ts'
import { createSoftAuthenticator } from '@git-forge/accounts/test/support/soft-authenticator.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import { type LoginSettings, parseLoginSettings } from '../../src/config.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

class Browser {
  readonly cookies = new Map<string, string>()

  constructor(readonly forge: NodeForge) {}

  async fetch(path: string, init: RequestInit & { csrf?: string; origin?: string | null } = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.cookies.size > 0) headers.set('Cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '))
    if (init.csrf) headers.set('X-CSRF-Token', init.csrf)
    const method = init.method ?? 'GET'
    if (method !== 'GET' && init.origin !== null) headers.set('Origin', init.origin ?? BASE)
    const response = await this.forge.fetch(new Request(new URL(path, BASE), { ...init, headers }))
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split('; ')
      const [name, value] = pair!.split('=') as [string, string]
      if (attributes.includes('Max-Age=0')) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }

  json(path: string, body: unknown, csrf?: string) {
    return this.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(csrf ? { csrf } : {}) })
  }

  form(path: string, fields: Record<string, string>) {
    return this.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
  }

  async csrf(): Promise<string> {
    return ((await (await this.fetch('/api/session')).json()) as { csrfToken: string }).csrfToken
  }
}

const json = async <T = Record<string, unknown>>(response: Response): Promise<T> => (await response.json()) as T

const loginForge = async (login: Partial<LoginSettings>, mock?: MockOidc, clock?: { now: number }, clientAddress?: (request: Request) => string | null) =>
  nodeForge({
    login: { oidc: undefined, selfSignup: false, breakGlassKey: undefined, ...login },
    ...(mock ? { fetch: (request: Request) => mock.handle(request) } : {}),
    ...(clock ? { now: () => new Date(clock.now) } : {}),
    ...(clientAddress ? { clientAddress } : {}),
  })

const pkce = async () => {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: await pkceChallenge(verifier) }
}

const OOB = 'urn:ietf:wg:oauth:2.0:oob'

const registerPasskey = async (browser: Browser, authenticator: Awaited<ReturnType<typeof createSoftAuthenticator>>, body: Record<string, unknown>, csrf?: string) => {
  const options = await browser.json('/login/passkey/register/options', body, csrf)
  if (options.status !== 200) return options
  const { handle, publicKey } = await json<{ handle: string; publicKey: { challenge: string; user: { id: string } } }>(options)
  return browser.json('/login/passkey/register', { handle, credential: await authenticator.create(publicKey), name: 'laptop' }, csrf)
}

const passkeyLogin = async (browser: Browser, authenticator: Awaited<ReturnType<typeof createSoftAuthenticator>>) => {
  const { handle, publicKey } = await json<{ handle: string; publicKey: { challenge: string } }>(await browser.json('/login/passkey/options', {}))
  return browser.json('/login/passkey', { handle, credential: await authenticator.get(publicKey) })
}

describe('passkeys', () => {
  it('creates a passkey-only account from an invite and signs in again', async () => {
    const forge = await loginForge({})
    const admin = await bootstrap(forge, BASE)
    const authenticator = await createSoftAuthenticator({ origin: BASE })
    const browser = new Browser(forge)
    expect((await registerPasskey(browser, authenticator, { login: 'carol' })).status).toBe(403)
    const invite = await json<{ code: string; url: string }>(await call(forge, BASE, 'POST', '/api/admin/invites', admin, { login: 'carol' }))
    expect(invite.url).toBe(`${BASE}/login/invite/${invite.code}`)
    expect((await browser.fetch(`/login/invite/${invite.code}`)).status).toBe(200)
    const registered = await registerPasskey(browser, authenticator, { invite: invite.code })
    expect(registered.status).toBe(201)
    expect(await json(registered)).toEqual({ login: 'carol', created: true })
    expect(await json(await browser.fetch('/api/session'))).toMatchObject({ login: 'carol', method: 'passkey', admin: false })
    expect((await registerPasskey(new Browser(forge), await createSoftAuthenticator({ origin: BASE }), { invite: invite.code })).status).toBe(400)

    const fresh = new Browser(forge)
    const login = await passkeyLogin(fresh, authenticator)
    expect(login.status).toBe(200)
    expect(await json(await fresh.fetch('/api/user'))).toMatchObject({ login: 'carol', via: 'session' })
    const passkeys = await json<{ id: string; name: string }[]>(await fresh.fetch('/api/user/passkeys'))
    expect(passkeys).toEqual([expect.objectContaining({ name: 'laptop' })])
  })

  it('lets a browser session read media and raw URLs of repositories it may read', async () => {
    const forge = await loginForge({})
    const admin = await bootstrap(forge, BASE)
    const authenticator = await createSoftAuthenticator({ origin: BASE })
    const browser = new Browser(forge)
    const invite = await json<{ code: string }>(await call(forge, BASE, 'POST', '/api/admin/invites', admin, { login: 'erin' }))
    expect((await registerPasskey(browser, authenticator, { invite: invite.code })).status).toBe(201)
    expect((await call(forge, BASE, 'POST', '/api/repos', admin, { owner: 'admin', name: 'secret' })).status).toBe(201)
    const raw = '/admin/secret/raw/main/README.md'
    expect((await forge.fetch(new Request(`${BASE}${raw}`))).status).toBe(401)
    expect((await browser.fetch(raw)).status).toBe(401)
    expect((await call(forge, BASE, 'PUT', '/api/repos/admin/secret/collaborators/erin', admin, { role: 'read' })).status).toBe(200)
    const allowed = await browser.fetch(raw)
    expect(allowed.status).toBe(404)
    expect(await allowed.text()).toContain('unknown ref')
  })

  it('rejects assertions for another origin, without user verification, or replayed', async () => {
    const forge = await loginForge({ selfSignup: true })
    const authenticator = await createSoftAuthenticator({ origin: BASE })
    const browser = new Browser(forge)
    expect((await registerPasskey(browser, authenticator, { login: 'dave' })).status).toBe(201)
    const options = await json<{ handle: string; publicKey: { challenge: string } }>(await browser.json('/login/passkey/options', {}))
    const phished = await browser.json('/login/passkey', { handle: options.handle, credential: await authenticator.get(options.publicKey, undefined, 'https://evil.example') })
    expect(phished.status).toBe(401)
    expect((await browser.json('/login/passkey', { handle: options.handle, credential: await authenticator.get(options.publicKey) })).status).toBe(400)
    const again = await json<{ handle: string; publicKey: { challenge: string } }>(await browser.json('/login/passkey/options', {}))
    const assertion = await authenticator.get(again.publicKey)
    authenticator.credentials.values().next().value!.counter = 0
    const stale = await authenticator.get(again.publicKey)
    expect((await browser.json('/login/passkey', { handle: again.handle, credential: assertion })).status).toBe(200)
    const replay = await json<{ handle: string }>(await browser.json('/login/passkey/options', {}))
    expect((await browser.json('/login/passkey', { handle: replay.handle, credential: stale })).status).toBe(401)
    const lazy = await createSoftAuthenticator({ origin: BASE, userVerified: false })
    expect((await registerPasskey(new Browser(forge), lazy, { login: 'erin' })).status).toBe(401)
    expect((await registerPasskey(new Browser(forge), authenticator, { login: 'dave' })).status).toBe(409)
  })

  it('adds a second passkey to a signed-in account only with a CSRF token', async () => {
    const forge = await loginForge({ selfSignup: true })
    const browser = new Browser(forge)
    expect((await registerPasskey(browser, await createSoftAuthenticator({ origin: BASE }), { login: 'frank' })).status).toBe(201)
    const second = await createSoftAuthenticator({ origin: BASE })
    expect((await registerPasskey(browser, second, {})).status).toBe(403)
    expect((await registerPasskey(browser, second, {}, await browser.csrf())).status).toBe(200)
    expect(await json<unknown[]>(await browser.fetch('/api/user/passkeys'))).toHaveLength(2)
    expect((await passkeyLogin(new Browser(forge), second)).status).toBe(200)
  })
  it('turns passkey login, registration and management off with PASSKEYS=false, keeping break-glass', async () => {
    expect(parseLoginSettings({}).passkeys).toBe(true)
    expect(parseLoginSettings({ PASSKEYS: 'true' }).passkeys).toBe(true)
    expect(parseLoginSettings({ PASSKEYS: 'false' }).passkeys).toBe(false)
    const { privateJwk } = await generateSigningKey()
    const forge = await loginForge({ selfSignup: true, passkeys: false, breakGlassKey: { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x } })
    await bootstrap(forge, BASE, 'root')
    const anonymous = new Browser(forge)
    expect((await anonymous.json('/login/passkey/options', {})).status).toBe(404)
    expect((await anonymous.json('/login/passkey', { handle: 'x', credential: {} })).status).toBe(404)
    expect((await anonymous.json('/login/passkey/register/options', { login: 'mallory' })).status).toBe(404)
    expect((await anonymous.json('/login/passkey/register', { handle: 'x', credential: {} })).status).toBe(404)
    const page = await (await anonymous.fetch('/login')).text()
    expect(page).not.toContain('data-passkey')
    expect(page).toContain('href="/login/break-glass"')
    const admin = new Browser(forge)
    expect((await admin.form('/login/break-glass', { token: await signBreakGlassToken({ privateJwk, audience: BASE, login: 'root' }) })).status).toBe(303)
    const csrf = await admin.csrf()
    expect((await admin.json('/login/passkey/register/options', {}, csrf)).status).toBe(404)
    expect((await admin.fetch('/api/user/passkeys')).status).toBe(404)
    expect((await admin.fetch('/api/user/passkeys/abc', { method: 'DELETE', csrf })).status).toBe(404)
  })
})

describe('sessions', () => {
  it('authorizes the JSON API with the session, CSRF token and same origin', async () => {
    const forge = await loginForge({ selfSignup: true })
    const browser = new Browser(forge)
    await registerPasskey(browser, await createSoftAuthenticator({ origin: BASE }), { login: 'gina' })
    const body = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: 'gina', name: 'notes' }) }
    expect((await browser.fetch('/api/repos', body)).status).toBe(403)
    const csrf = await browser.csrf()
    expect((await browser.fetch('/api/repos', { ...body, csrf, origin: 'https://evil.example' })).status).toBe(403)
    expect((await browser.fetch('/api/repos', { ...body, csrf })).status).toBe(201)
    expect((await browser.fetch('/logout', { method: 'POST', headers: { Accept: 'application/json' } })).status).toBe(403)
    expect((await browser.fetch('/logout', { method: 'POST', headers: { Accept: 'application/json' }, csrf })).status).toBe(200)
    expect(browser.cookies.has('__Host-gf_session')).toBe(false)
    expect((await browser.fetch('/api/session')).status).toBe(401)
  })

  it('manages branch protection with the session, CSRF token and same origin', async () => {
    const forge = await loginForge({ selfSignup: true })
    const browser = new Browser(forge)
    await registerPasskey(browser, await createSoftAuthenticator({ origin: BASE }), { login: 'hana' })
    const csrf = await browser.csrf()
    const create = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: 'hana', name: 'notes' }), csrf }
    expect((await browser.fetch('/api/repos', create)).status).toBe(201)
    const path = '/api/repos/hana/notes/branches/main/protection'
    const put = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allow_deletions: true }) }
    expect((await browser.fetch(path, put)).status).toBe(401)
    expect((await browser.fetch(path, { ...put, csrf, origin: 'https://evil.example' })).status).toBe(401)
    const stored = await browser.fetch(path, { ...put, csrf })
    expect(stored.status).toBe(200)
    expect(await json(stored)).toMatchObject({ pattern: 'main', allow_deletions: { enabled: true }, allow_force_pushes: { enabled: false } })
    expect(await json<unknown[]>(await browser.fetch('/api/repos/hana/notes/branch-protection'))).toHaveLength(1)
    expect((await new Browser(forge).fetch(path)).status).toBe(401)
    expect((await browser.fetch(path, { method: 'DELETE' })).status).toBe(401)
    expect((await browser.fetch(path, { method: 'DELETE', csrf })).status).toBe(204)
    expect((await browser.fetch(path)).status).toBe(404)
  })

  it('serves a login page and refuses cross-origin form posts', async () => {
    const forge = await loginForge({ selfSignup: true })
    const page = await new Browser(forge).fetch('/login?return_to=//evil.example')
    expect(page.headers.get('Content-Type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('Sign in with a passkey')
    expect(html).not.toContain('evil.example')
    expect((await new Browser(forge).fetch('/login/passkey/options', { method: 'POST', origin: 'https://evil.example' })).status).toBe(403)
  })
})

describe('OIDC', () => {
  let mock: MockOidc

  beforeEach(async () => {
    mock = await createMockOidc({ issuer: 'https://dorf-id.example' })
  })

  const oidcSettings = (selfSignup: boolean): Partial<LoginSettings> => ({
    oidc: { issuer: mock.issuer, clientId: mock.clientId, clientSecret: mock.clientSecret, scopes: ['openid', 'profile', 'email'], name: 'Dorf-ID' },
    selfSignup,
  })

  const signIn = async (browser: Browser, path = '/login/oidc?return_to=/acme') => {
    const start = await browser.fetch(path)
    expect(start.status).toBe(303)
    const authorize = await mock.handle(new Request(start.headers.get('Location')!))
    const callback = new URL(authorize.headers.get('Location')!)
    expect(callback.origin + callback.pathname).toBe(`${BASE}/login/oidc/callback`)
    return browser.fetch(callback.pathname + callback.search)
  }

  it('requires an invite or an existing link without self-signup', async () => {
    const forge = await loginForge(oidcSettings(false), mock)
    const admin = await bootstrap(forge, BASE)
    const refused = await signIn(new Browser(forge))
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain('invite')

    const invite = await json<{ code: string }>(await call(forge, BASE, 'POST', '/api/admin/invites', admin, {}))
    const browser = new Browser(forge)
    const accepted = await signIn(browser, `/login/oidc?invite=${invite.code}`)
    expect(accepted.status).toBe(303)
    expect(accepted.headers.get('Location')).toBe('/')
    expect(await json(await browser.fetch('/api/session'))).toMatchObject({ login: 'alice', method: 'oidc' })

    const again = new Browser(forge)
    const second = await signIn(again)
    expect(second.headers.get('Location')).toBe('/acme')
    expect(await json(await again.fetch('/api/session'))).toMatchObject({ login: 'alice' })
  })

  it('redeems a one-time instance admin claim on the first matching OIDC sign-in', async () => {
    mock.user = { sub: 'zitadel-7', preferred_username: 'levin', email: 'Levin@Example.org', email_verified: true }
    const forge = await loginForge(oidcSettings(false), mock)
    await createAccountsStore(forge.db).addInstanceAdminClaim('levin@example.org')
    const browser = new Browser(forge)
    expect((await signIn(browser)).status).toBe(303)
    expect(await json(await browser.fetch('/api/session'))).toMatchObject({ login: 'levin', admin: true })

    mock.user = { sub: 'zitadel-8', preferred_username: 'mallory', email: 'levin@example.org', email_verified: true }
    expect((await signIn(new Browser(forge))).status).toBe(403)
  })

  it('links an existing account through an invite for that user', async () => {
    const forge = await loginForge(oidcSettings(false), mock)
    const admin = await bootstrap(forge, BASE, 'root')
    const invite = await json<{ code: string }>(await call(forge, BASE, 'POST', '/api/admin/invites', admin, { user: 'root' }))
    const browser = new Browser(forge)
    await signIn(browser, `/login/oidc?invite=${invite.code}`)
    expect(await json(await browser.fetch('/api/session'))).toMatchObject({ login: 'root', admin: true })
  })

  it('takes the login from userinfo when the ID token carries only the subject', async () => {
    mock.userinfoOnly = true
    mock.user = { sub: 'zitadel-42', preferred_username: 'levin@dorf.example', email: 'levin@dorf.example', email_verified: true }
    const forge = await loginForge(oidcSettings(true), mock)
    const browser = new Browser(forge)
    expect((await signIn(browser)).status).toBe(303)
    expect(await json(await browser.fetch('/api/session'))).toMatchObject({ login: 'levin' })
  })

  it('creates accounts with self-signup and refuses unbound or forged callbacks', async () => {
    const forge = await loginForge(oidcSettings(true), mock)
    const browser = new Browser(forge)
    expect((await signIn(browser)).status).toBe(303)
    expect(await json(await browser.fetch('/api/session'))).toMatchObject({ login: 'alice' })

    const start = await new Browser(forge).fetch('/login/oidc')
    const authorize = await mock.handle(new Request(start.headers.get('Location')!))
    const callback = new URL(authorize.headers.get('Location')!)
    expect((await new Browser(forge).fetch(callback.pathname + callback.search)).status).toBe(400)

    const victim = new Browser(forge)
    mock.claimOverrides = { nonce: 'forged' }
    expect((await signIn(victim)).status).toBe(401)
    mock.claimOverrides = { aud: 'other-client' }
    expect((await signIn(victim)).status).toBe(401)
    mock.claimOverrides = {}
    mock.user = { sub: 'user-2', preferred_username: 'alice' }
    await signIn(victim)
    expect(await json(await victim.fetch('/api/session'))).toMatchObject({ login: 'alice-2' })
  })
})

describe('device flow', () => {
  it('issues a git token after approval in the browser', async () => {
    const clock = { now: Date.now() }
    const forge = await loginForge({ selfSignup: true }, undefined, clock)
    const browser = new Browser(forge)
    await registerPasskey(browser, await createSoftAuthenticator({ origin: BASE }), { login: 'hank' })
    const cli = new Browser(forge)
    expect((await cli.form('/login/device/code', { client_id: 'other' })).status).toBe(400)
    const started = await json<{ device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; interval: number }>(
      await cli.form('/login/device/code', { client_id: 'git-forge-cli', client_name: 'git forge auth login on laptop' }),
    )
    expect(started.verification_uri).toBe(`${BASE}/login/device`)
    const poll = () => cli.form('/login/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: started.device_code, client_id: 'git-forge-cli' })
    expect(await json(await poll())).toEqual({ error: 'authorization_pending' })
    expect(await json(await poll())).toEqual({ error: 'slow_down', interval: 10 })

    const anonymous = await new Browser(forge).fetch(new URL(started.verification_uri_complete).pathname + new URL(started.verification_uri_complete).search)
    expect(anonymous.status).toBe(303)
    expect(anonymous.headers.get('Location')).toContain('/login?return_to=')
    const page = await (await browser.fetch(`/login/device?user_code=${started.user_code.toLowerCase()}`)).text()
    expect(page).toContain('git forge auth login on laptop')
    expect(page).toContain('Only approve a request you started yourself')
    expect(page).toContain('value="repo:write" checked')
    expect(page).not.toContain('value="repo:admin"')
    expect((await browser.form('/login/device', { user_code: started.user_code, decision: 'approve' })).status).toBe(403)
    const approved = await browser.form('/login/device', { user_code: started.user_code, decision: 'approve', csrf: await browser.csrf() })
    expect(await approved.text()).toContain('Device connected')

    clock.now += 11_000
    const token = await poll()
    expect(token.status).toBe(200)
    const issued = await json<{ access_token: string; login: string; scope: string }>(token)
    expect(issued).toMatchObject({ login: 'hank', scope: 'repo:write', access_token: expect.stringMatching(/^gfp_/) })
    clock.now += 11_000
    expect(await json(await poll())).toEqual({ error: 'expired_token' })

    expect((await call(forge, BASE, 'POST', '/api/repos', issued.access_token, { owner: 'hank', name: 'x' })).status).toBe(403)
    expect(await json(await call(forge, BASE, 'GET', '/api/user', issued.access_token))).toMatchObject({ login: 'hank', via: 'token', ceiling: 'write' })
  })

  it('issues the requested scope at most, with host, address and time on the consent page', async () => {
    const clock = { now: Date.UTC(2026, 9, 18, 12, 0, 0) }
    const forge = await loginForge({ selfSignup: true }, undefined, clock, () => '203.0.113.7')
    const browser = new Browser(forge)
    await registerPasskey(browser, await createSoftAuthenticator({ origin: BASE }), { login: 'jo' })
    const cli = new Browser(forge)
    expect(await json(await cli.form('/login/device/code', { client_id: 'git-forge-cli', scope: 'repo:root' }))).toMatchObject({ error: 'invalid_scope' })
    const admin = await json<{ device_code: string; user_code: string }>(await cli.form('/login/device/code', { client_id: 'git-forge-cli', client_host: 'build-box', scope: 'repo:admin' }))
    const page = await (await browser.fetch(`/login/device?user_code=${admin.user_code}`)).text()
    expect(page).toContain('build-box')
    expect(page).toContain('203.0.113.7')
    expect(page).toContain('2026-10-18 12:00:00 UTC')
    expect(page).toContain('admin (includes write)')
    await browser.form('/login/device', { user_code: admin.user_code, decision: 'approve', scope: 'repo:admin', csrf: await browser.csrf() })
    const poll = (deviceCode: string) => cli.form('/login/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: 'git-forge-cli' })
    const issued = await json<{ access_token: string; scope: string }>(await poll(admin.device_code))
    expect(issued.scope).toBe('repo:admin')
    expect((await call(forge, BASE, 'POST', '/api/repos', issued.access_token, { owner: 'jo', name: 'made-by-cli' })).status).toBe(201)
    expect((await call(forge, BASE, 'POST', '/api/repos', issued.access_token, { owner: 'hank', name: 'not-mine' })).status).toBe(404)

    const read = await json<{ device_code: string; user_code: string }>(await cli.form('/login/device/code', { client_id: 'git-forge-cli', scope: 'repo:read' }))
    await browser.form('/login/device', { user_code: read.user_code, decision: 'approve', scope: 'repo:admin', csrf: await browser.csrf() })
    expect(await json(await poll(read.device_code))).toMatchObject({ scope: 'repo:read' })
  })

  it('tells the client when the user denies', async () => {
    const clock = { now: Date.now() }
    const forge = await loginForge({ selfSignup: true }, undefined, clock)
    const browser = new Browser(forge)
    await registerPasskey(browser, await createSoftAuthenticator({ origin: BASE }), { login: 'ivy' })
    const started = await json<{ device_code: string; user_code: string }>(await new Browser(forge).form('/login/device/code', { client_id: 'git-forge-cli' }))
    await browser.form('/login/device', { user_code: started.user_code, decision: 'deny', csrf: await browser.csrf() })
    const poll = await new Browser(forge).form('/login/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: started.device_code, client_id: 'git-forge-cli' })
    expect(await json(poll)).toEqual({ error: 'access_denied' })
  })
})

describe('command line login', () => {
  const signedIn = async (login: string, clock = { now: Date.now() }) => {
    const forge = await loginForge({ selfSignup: true }, undefined, clock, () => '198.51.100.4')
    const browser = new Browser(forge)
    await registerPasskey(browser, await createSoftAuthenticator({ origin: BASE }), { login })
    return { forge, browser, cli: new Browser(forge), clock }
  }

  const start = async (cli: Browser, fields: Record<string, string>) =>
    cli.form('/login/cli/start', { client_id: 'git-forge-cli', client_name: 'git forge auth login', client_host: 'laptop', ...fields })

  const exchange = (cli: Browser, fields: Record<string, string>) => cli.form('/login/cli/token', { grant_type: 'authorization_code', client_id: 'git-forge-cli', ...fields })

  it('shows a one-time code bound to the PKCE verifier', async () => {
    const { forge, browser, cli } = await signedIn('kim')
    const { verifier, challenge } = await pkce()
    const started = await json<{ authorization_url: string; request_id: string }>(await start(cli, { redirect_uri: OOB, code_challenge: challenge, scope: 'repo:admin' }))
    expect(started.authorization_url).toBe(`${BASE}/login/cli/${started.request_id}`)
    expect(started.request_id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const path = new URL(started.authorization_url).pathname
    const anonymous = await new Browser(forge).fetch(path)
    expect(anonymous.status).toBe(303)
    expect(anonymous.headers.get('Location')).toBe(`/login?return_to=${encodeURIComponent(path)}`)
    const consent = await browser.fetch(path)
    const html = await consent.text()
    expect(html).toContain('laptop')
    expect(html).toContain('198.51.100.4')
    expect(html).toContain('admin (includes write)')
    expect(html).toContain('Only approve a request you started yourself')
    expect(consent.headers.get('Content-Security-Policy')).toContain("form-action 'self';")
    expect((await browser.form(path, { decision: 'approve' })).status).toBe(403)
    const approved = await (await browser.form(path, { decision: 'approve', scope: 'repo:write', csrf: await browser.csrf() })).text()
    const code = /value="(gfc_[A-Za-z0-9_-]+)"/.exec(approved)?.[1]
    expect(code).toBeDefined()
    expect(approved).toContain('data-copy="cli-code"')
    expect(await (await browser.form(path, { decision: 'approve', csrf: await browser.csrf() })).text()).toContain('unknown, expired or already answered')

    expect(await json(await exchange(cli, { code: code!, code_verifier: (await pkce()).verifier, redirect_uri: OOB }))).toEqual({ error: 'invalid_grant' })
    expect(await json(await exchange(cli, { code: code!, code_verifier: verifier, redirect_uri: OOB }))).toEqual({ error: 'invalid_grant' })

    const second = await pkce()
    const again = await json<{ authorization_url: string }>(await start(cli, { redirect_uri: OOB, code_challenge: second.challenge, scope: 'repo:admin' }))
    const page = await (await browser.form(new URL(again.authorization_url).pathname, { decision: 'approve', scope: 'repo:admin', csrf: await browser.csrf() })).text()
    const fresh = /value="(gfc_[A-Za-z0-9_-]+)"/.exec(page)![1]!
    const token = await json<{ access_token: string; scope: string; login: string }>(await exchange(cli, { code: fresh, code_verifier: second.verifier, redirect_uri: OOB }))
    expect(token).toMatchObject({ login: 'kim', scope: 'repo:admin', access_token: expect.stringMatching(/^gfp_/) })
    expect(await json(await exchange(cli, { code: fresh, code_verifier: second.verifier, redirect_uri: OOB }))).toEqual({ error: 'invalid_grant' })
    expect((await call(forge, BASE, 'POST', '/api/repos', token.access_token, { owner: 'kim', name: 'tool' })).status).toBe(201)
  })

  it('redirects to a loopback address with code and state, and only there', async () => {
    const { browser, cli } = await signedIn('lee')
    const { verifier, challenge } = await pkce()
    for (const redirect of ['http://evil.example/callback', 'https://127.0.0.1:5000/callback', 'http://127.0.0.1.evil.example/cb', 'http://user@127.0.0.1:5/cb']) {
      expect((await start(cli, { redirect_uri: redirect, code_challenge: challenge, state: 's' })).status).toBe(400)
    }
    expect((await start(cli, { redirect_uri: 'http://127.0.0.1:5000/callback', code_challenge: challenge })).status).toBe(400)
    expect((await start(cli, { redirect_uri: OOB, code_challenge: 'short' })).status).toBe(400)
    const redirectUri = 'http://127.0.0.1:5000/callback'
    const started = await json<{ authorization_url: string }>(await start(cli, { redirect_uri: redirectUri, code_challenge: challenge, state: 'xyz' }))
    const path = new URL(started.authorization_url).pathname
    const consent = await browser.fetch(path)
    expect(consent.headers.get('Content-Security-Policy')).toContain("form-action 'self' http://127.0.0.1:* http://localhost:*")
    expect(await consent.text()).toContain(redirectUri)
    const approved = await browser.form(path, { decision: 'approve', csrf: await browser.csrf() })
    expect(approved.status).toBe(303)
    const location = new URL(approved.headers.get('Location')!)
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri)
    expect(location.searchParams.get('state')).toBe('xyz')
    const code = location.searchParams.get('code')!
    expect(await json(await exchange(cli, { code, code_verifier: verifier, redirect_uri: OOB }))).toEqual({ error: 'invalid_grant' })

    const second = await pkce()
    const next = await json<{ authorization_url: string }>(await start(cli, { redirect_uri: redirectUri, code_challenge: second.challenge, state: 'abc', scope: 'repo:read' }))
    const nextApproved = await browser.form(new URL(next.authorization_url).pathname, { decision: 'approve', scope: 'repo:admin', csrf: await browser.csrf() })
    const nextCode = new URL(nextApproved.headers.get('Location')!).searchParams.get('code')!
    expect(await json(await exchange(cli, { code: nextCode, code_verifier: second.verifier, redirect_uri: redirectUri }))).toMatchObject({ login: 'lee', scope: 'repo:read' })

    const denied = await json<{ authorization_url: string }>(await start(cli, { redirect_uri: redirectUri, code_challenge: challenge, state: 'no' }))
    const refusal = await browser.form(new URL(denied.authorization_url).pathname, { decision: 'deny', csrf: await browser.csrf() })
    expect(Object.fromEntries(new URL(refusal.headers.get('Location')!).searchParams)).toEqual({ error: 'access_denied', state: 'no' })
  })

  it('rate-limits device and login endpoints per client address', async () => {
    const forge = await loginForge({}, undefined, undefined, (request) => request.headers.get('X-Test-Address'))
    const from = (address: string) => forge.fetch(new Request(`${BASE}/login/device/code`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Test-Address': address }, body: 'client_id=git-forge-cli' }))
    for (let i = 0; i < 30; i++) expect((await from('192.0.2.1')).status).toBe(200)
    const limited = await from('192.0.2.1')
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(await json(limited)).toMatchObject({ error: 'rate_limited' })
    expect((await from('192.0.2.2')).status).toBe(200)
  })

  it('purges expired challenges, device codes, CLI requests and rate-limit windows on the schedule', async () => {
    const { forge, cli, clock } = await signedIn('max')
    await cli.form('/login/device/code', { client_id: 'git-forge-cli' })
    await start(cli, { redirect_uri: OOB, code_challenge: (await pkce()).challenge })
    await cli.json('/login/passkey/options', {})
    const count = async (table: string) => Number((await forge.db.all<{ n: number }>({ sql: `SELECT COUNT(*) AS n FROM ${table}`, params: [] }))[0]!.n)
    expect(await count('device_authorizations')).toBe(1)
    expect(await count('cli_authorizations')).toBe(1)
    expect(await count('rate_limits')).toBeGreaterThan(0)
    const challenges = await count('login_challenges')
    expect(challenges).toBeGreaterThan(0)
    await forge.scheduled(new Date(clock.now))
    expect(await count('device_authorizations')).toBe(1)
    clock.now += 3 * 60 * 60 * 1000
    await forge.scheduled(new Date(clock.now))
    for (const table of ['device_authorizations', 'cli_authorizations', 'login_challenges', 'rate_limits']) expect(await count(table)).toBe(0)
  })
})

describe('break-glass', () => {
  let privateJwk: PrivateJwk

  beforeEach(async () => {
    privateJwk = (await generateSigningKey()).privateJwk
  })

  it('creates a short instance admin session from an offline-signed token, once', async () => {
    const forge = await loginForge({ breakGlassKey: { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x } })
    const admin = await bootstrap(forge, BASE, 'root')
    await call(forge, BASE, 'POST', '/api/admin/users', admin, { login: 'jo' })
    const browser = new Browser(forge)
    expect((await browser.fetch('/login/break-glass')).status).toBe(200)
    const token = await signBreakGlassToken({ privateJwk, audience: BASE, login: 'root' })
    const signedIn = await browser.form('/login/break-glass', { token })
    expect(signedIn.status).toBe(303)
    expect(await json(await browser.fetch('/api/session'))).toMatchObject({ login: 'root', method: 'break-glass', admin: true })
    expect(await (await new Browser(forge).form('/login/break-glass', { token })).text()).toContain('already used')
    const notAdmin = await new Browser(forge).form('/login/break-glass', { token: await signBreakGlassToken({ privateJwk, audience: BASE, login: 'jo' }) })
    expect(await notAdmin.text()).toContain('not an instance admin')
    const other = await signBreakGlassToken({ privateJwk: (await generateSigningKey()).privateJwk, audience: BASE, login: 'root' })
    expect(await (await new Browser(forge).form('/login/break-glass', { token: other })).text()).toContain('not signed by the configured key')
  })

  it('is off without a configured key', async () => {
    const forge = await loginForge({})
    expect((await new Browser(forge).fetch('/login/break-glass')).status).toBe(404)
  })
})
