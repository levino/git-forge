import { base64UrlEncode, pkceChallenge } from '@git-forge/accounts'
import { createSoftAuthenticator } from '@git-forge/accounts/test/support/soft-authenticator.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import { basicAuthorization } from '../../src/app.ts'
import { type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'
const CALLBACK = 'http://localhost:4567/callback'
const MODERN = '2026-07-28'

type Json = Record<string, any>

class Browser {
  readonly cookies = new Map<string, string>()

  constructor(readonly forge: NodeForge) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.cookies.size > 0) headers.set('Cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '))
    if ((init.method ?? 'GET') !== 'GET') headers.set('Origin', BASE)
    const response = await this.forge.fetch(new Request(new URL(path, BASE), { ...init, headers }))
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split('; ')
      const [name, value] = pair!.split('=') as [string, string]
      this.cookies.set(name, value)
    }
    return response
  }

  json(path: string, body: unknown, csrf?: string) {
    return this.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: JSON.stringify(body) })
  }

  async csrf(): Promise<string> {
    return ((await (await this.fetch('/api/session')).json()) as { csrfToken: string }).csrfToken
  }
}

const post = (forge: NodeForge, path: string, body: string, headers: Record<string, string> = {}) =>
  forge.fetch(new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body }))

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()

const pkce = async () => {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: await pkceChallenge(verifier) }
}

let clock: { now: number }
let forge: NodeForge
let browser: Browser

const signUp = async (login: string) => {
  const authenticator = await createSoftAuthenticator({ origin: BASE })
  const options = (await (await browser.json('/login/passkey/register/options', { login })).json()) as { handle: string; publicKey: never }
  expect((await browser.json('/login/passkey/register', { handle: options.handle, credential: await authenticator.create(options.publicKey), name: 'laptop' })).status).toBe(201)
}

const registerClient = async (redirectUris = [CALLBACK]) => {
  const response = await forge.fetch(
    new Request(`${BASE}/login/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code (forge)', redirect_uris: redirectUris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    }),
  )
  expect(response.status).toBe(201)
  return ((await response.json()) as { client_id: string }).client_id
}

const authorizeQuery = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
  form({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'repo:admin', resource: `${BASE}/mcp`, ...extra })

const approve = async (query: string, choices: Record<string, string>) => {
  const response = await browser.fetch('/login/oauth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ csrf: await browser.csrf(), request: query, decision: 'approve', ...choices }),
  })
  expect(response.status).toBe(303)
  return new URL(response.headers.get('Location')!)
}

const connect = async (choices: Record<string, string> = { scope: 'repo:write' }) => {
  const clientId = await registerClient()
  const { verifier, challenge } = await pkce()
  const callback = await approve(authorizeQuery(clientId, challenge), choices)
  const response = await post(forge, '/login/oauth/token', form({ grant_type: 'authorization_code', client_id: clientId, code: callback.searchParams.get('code')!, code_verifier: verifier, redirect_uri: CALLBACK, resource: `${BASE}/mcp` }))
  expect(response.status).toBe(200)
  return { clientId, ...((await response.json()) as { access_token: string; refresh_token: string; scope: string; expires_in: number }) }
}

let nextId = 1

const rpc = async (token: string, method: string, params: Json = {}, modern = true) => {
  const body = { jsonrpc: '2.0', id: nextId++, method, params: modern ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' } } } : params }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (modern) Object.assign(headers, { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method, ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}) })
  return forge.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) }))
}

const tool = async (token: string, name: string, args: Json = {}) => ((await (await rpc(token, 'tools/call', { name, arguments: args })).json()) as Json).result as Json

const gitStatus = async (repo: string, token: string) =>
  (await forge.fetch(new Request(`${BASE}/${repo}.git/info/refs?service=git-upload-pack`, { headers: { Authorization: basicAuthorization('x', token) } }))).status

beforeEach(async () => {
  clock = { now: Date.parse('2026-10-21T10:00:00Z') }
  forge = await nodeForge({ login: { oidc: undefined, selfSignup: true, breakGlassKey: undefined }, now: () => new Date(clock.now) })
  browser = new Browser(forge)
  await signUp('dave')
  const csrf = await browser.csrf()
  for (const name of ['one', 'two']) expect((await browser.json('/api/repos', { owner: 'dave', name, visibility: 'private' }, csrf)).status).toBe(201)
})

describe('agent connections over MCP', () => {
  it('advertises protected resource and authorization server metadata', async () => {
    const unauthenticated = await forge.fetch(new Request(`${BASE}/mcp`, { method: 'POST', body: '{}' }))
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`)
    const resource = (await (await forge.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`))).json()) as Json
    expect(resource).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] })
    const server = (await (await forge.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json()) as Json
    expect(server).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/login/oauth/authorize`,
      token_endpoint: `${BASE}/login/oauth/token`,
      registration_endpoint: `${BASE}/login/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    })
  })

  it('runs DCR, consent with PKCE and the token tool, and the issued token works for git within the grant', async () => {
    const clientId = await registerClient()
    const { verifier, challenge } = await pkce()
    const query = authorizeQuery(clientId, challenge)
    const anonymous = await forge.fetch(new Request(`${BASE}/login/oauth/authorize?${query}`))
    expect(anonymous.status).toBe(303)
    expect(anonymous.headers.get('Location')).toMatch(/^\/login\?return_to=%2Flogin%2Foauth%2Fauthorize/)
    const page = await browser.fetch(`/login/oauth/authorize?${query}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('Content-Security-Policy')).toContain('form-action \'self\' http://127.0.0.1:* http://localhost:*')
    const html = await page.text()
    expect(html).toContain('Claude Code (forge)')
    expect(html).toContain('localhost (this computer)')
    const callback = await approve(query, { scope: 'repo:write', name: 'Claude Code on laptop', repositories: 'dave/one' })
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get('state')).toBe('xyz')
    expect(callback.searchParams.get('iss')).toBe(BASE)
    const code = callback.searchParams.get('code')!
    const exchange = (fields: Record<string, string>) => post(forge, '/login/oauth/token', form({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: CALLBACK, resource: `${BASE}/mcp`, ...fields }))
    expect(await (await exchange({ code_verifier: 'x'.repeat(43) })).json()).toEqual({ error: 'invalid_grant' })
    const tokens = (await (await exchange({ code_verifier: verifier })).json()) as Json
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'repo:write' })
    expect(tokens.access_token).toMatch(/^gfm_/)
    expect(tokens.refresh_token).toMatch(/^gfr_/)

    const initialize = (await (await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, false)).json()) as Json
    expect(initialize.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'git-forge' } })
    const notified = await forge.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }))
    expect(notified.status).toBe(202)
    const listed = (await (await rpc(tokens.access_token, 'tools/list')).json()) as Json
    expect(listed.result.resultType).toBe('complete')
    expect(listed.result.tools.map((item: Json) => item.name)).toEqual(['token', 'whoami'])
    expect((await tool(tokens.access_token, 'whoami')).structuredContent).toMatchObject({ login: 'dave', connection: 'Claude Code on laptop', scope: 'repo:write', repositories: ['dave/one'] })

    const issued = await tool(tokens.access_token, 'token', { scope: 'repo:admin', ttl_minutes: 100000 })
    expect(issued.isError).toBeUndefined()
    expect(issued.structuredContent).toMatchObject({ scope: 'repo:write', repositories: ['dave/one'], login: 'dave', expires_at: new Date(clock.now + 24 * 60 * 60 * 1000).toISOString() })
    const pat = issued.structuredContent.token as string
    expect(await gitStatus('dave/one', pat)).toBe(200)
    expect(await gitStatus('dave/two', pat)).not.toBe(200)
    expect((await tool(tokens.access_token, 'token', { scope: 'repo:read', repositories: ['dave/two'] })).isError).toBe(true)
    expect((await tool(tokens.access_token, 'token', { scope: 'repo:read', repositories: ['nobody/else'] })).isError).toBe(true)

    const agents = await forge.services.account.listAgents({ kind: 'user', id: (await forge.services.store.findAccount('dave'))!.id, login: 'dave', limits: null, tokenId: null })
    expect(agents).toMatchObject([{ name: 'Claude Code on laptop', clientName: 'Claude Code (forge)', scope: 'repo:write', activeTokens: 1 }])
  })

  it('keeps audiences apart: MCP tokens are refused by the API and git, API tokens by MCP, foreign resources at the authorization server', async () => {
    const { access_token: access, clientId } = await connect()
    const pat = (await tool(access, 'token', { scope: 'repo:read' })).structuredContent.token as string
    expect((await forge.fetch(new Request(`${BASE}/api/user`, { headers: { Authorization: `Bearer ${access}` } }))).status).toBe(401)
    expect(await gitStatus('dave/one', access)).toBe(401)
    expect((await rpc(pat, 'tools/list')).status).toBe(401)
    expect((await forge.fetch(new Request(`${BASE}/api/user`, { headers: { Authorization: `Bearer ${pat}` } }))).status).toBe(200)
    const { challenge } = await pkce()
    const foreign = await browser.fetch(`/login/oauth/authorize?${authorizeQuery(clientId, challenge, { resource: 'https://evil.example/mcp' })}`)
    expect(foreign.status).toBe(303)
    expect(new URL(foreign.headers.get('Location')!).searchParams.get('error')).toBe('invalid_target')
    const refresh = await post(forge, '/login/oauth/token', form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: 'gfr_' + 'a'.repeat(43), resource: 'https://evil.example/mcp' }))
    expect(await refresh.json()).toMatchObject({ error: 'invalid_target' })
    expect((await browser.fetch(`/login/oauth/authorize?${authorizeQuery(clientId, challenge, { redirect_uri: 'https://evil.example/cb' })}`)).status).toBe(400)
  })

  it('rotates refresh tokens and revokes the whole connection when an old one is replayed', async () => {
    const first = await connect()
    const pat = (await tool(first.access_token, 'token', { scope: 'repo:read' })).structuredContent.token as string
    const refresh = (token: string) => post(forge, '/login/oauth/token', form({ grant_type: 'refresh_token', client_id: first.clientId, refresh_token: token, resource: `${BASE}/mcp` }))
    const second = (await (await refresh(first.refresh_token)).json()) as Json
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect((await rpc(second.access_token, 'ping')).status).toBe(200)
    expect(await (await refresh(first.refresh_token)).json()).toEqual({ error: 'invalid_grant' })
    expect((await rpc(second.access_token, 'ping')).status).toBe(401)
    expect(await (await refresh(second.refresh_token)).json()).toEqual({ error: 'invalid_grant' })
    expect(await gitStatus('dave/one', pat)).toBe(401)
  })

  it('revokes a connection with its refresh tokens and issued tokens immediately', async () => {
    const connection = await connect()
    const pat = (await tool(connection.access_token, 'token', { scope: 'repo:write' })).structuredContent.token as string
    expect(await gitStatus('dave/one', pat)).toBe(200)
    const dave = { kind: 'user' as const, id: (await forge.services.store.findAccount('dave'))!.id, login: 'dave', limits: null, tokenId: null }
    const [agent] = await forge.services.account.listAgents(dave)
    expect(await forge.services.account.revokeAgent(dave, agent!.id)).toBe(true)
    expect(await gitStatus('dave/one', pat)).toBe(401)
    expect((await rpc(connection.access_token, 'ping')).status).toBe(401)
    const refreshed = await post(forge, '/login/oauth/token', form({ grant_type: 'refresh_token', client_id: connection.clientId, refresh_token: connection.refresh_token, resource: `${BASE}/mcp` }))
    expect(await refreshed.json()).toEqual({ error: 'invalid_grant' })
    expect(await forge.services.account.listAgents(dave)).toEqual([])
  })

  it('expires MCP access tokens after an hour and issued tokens after their lifetime', async () => {
    const connection = await connect()
    const pat = (await tool(connection.access_token, 'token', { scope: 'repo:read', ttl_minutes: 5 })).structuredContent.token as string
    clock.now += 6 * 60 * 1000
    expect(await gitStatus('dave/one', pat)).toBe(401)
    clock.now += 60 * 60 * 1000
    expect((await rpc(connection.access_token, 'ping')).status).toBe(401)
    const refreshed = (await (await post(forge, '/login/oauth/token', form({ grant_type: 'refresh_token', client_id: connection.clientId, refresh_token: connection.refresh_token }))).json()) as Json
    expect((await rpc(refreshed.access_token, 'ping')).status).toBe(200)
  })

  it('validates modern request headers and protocol versions', async () => {
    const { access_token: access } = await connect()
    const send = (headers: Record<string, string>, meta: Json) =>
      forge.fetch(
        new Request(`${BASE}/mcp`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }),
        }),
      )
    const mismatch = await send({ 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call' }, { 'io.modelcontextprotocol/protocolVersion': MODERN })
    expect(mismatch.status).toBe(400)
    expect(((await mismatch.json()) as Json).error.code).toBe(-32020)
    const unsupported = await send({ 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' }, { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' })
    expect(unsupported.status).toBe(400)
    expect(((await unsupported.json()) as Json).error).toMatchObject({ code: -32022, data: { supported: expect.arrayContaining([MODERN, '2025-11-25']) } })
    expect((await rpc(access, 'resources/list')).status).toBe(404)
    expect((await forge.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${access}`, Origin: 'https://evil.example' }, body: '{}' }))).status).toBe(403)
    expect((await forge.fetch(new Request(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${access}` } }))).status).toBe(405)
  })

  it('denies with access_denied and refuses a consent without CSRF', async () => {
    const clientId = await registerClient()
    const { challenge } = await pkce()
    const query = authorizeQuery(clientId, challenge)
    const denied = await browser.fetch('/login/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ csrf: await browser.csrf(), request: query, decision: 'deny' }) })
    expect(new URL(denied.headers.get('Location')!).searchParams.get('error')).toBe('access_denied')
    const forged = await browser.fetch('/login/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ request: query, decision: 'approve' }) })
    expect(forged.status).toBe(403)
  })
})
