import { generateSigningKey, type PrivateJwk, signBreakGlassToken } from '@git-forge/accounts'
import { createMockOidc, type MockOidc } from '@git-forge/accounts/test/support/mock-oidc.ts'
import { createSoftAuthenticator } from '@git-forge/accounts/test/support/soft-authenticator.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import type { LoginSettings } from '../../src/config.ts'
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

const loginForge = async (login: Partial<LoginSettings>, mock?: MockOidc, clock?: { now: number }) =>
  nodeForge({
    login: { oidc: undefined, selfSignup: false, breakGlassKey: undefined, ...login },
    ...(mock ? { fetch: (request: Request) => mock.handle(request) } : {}),
    ...(clock ? { now: () => new Date(clock.now) } : {}),
  })

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
    const page = await browser.fetch(`/login/device?user_code=${started.user_code.toLowerCase()}`)
    expect(await page.text()).toContain('git forge auth login on laptop')
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
