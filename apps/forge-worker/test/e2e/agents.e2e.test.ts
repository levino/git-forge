import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { base64UrlEncode, pkceChallenge } from '@git-forge/accounts'
import { createSoftAuthenticator } from '@git-forge/accounts/test/support/soft-authenticator.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitFails, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

type Json = Record<string, any>

let dev: WranglerDev
const cookies = new Map<string, string>()

const browse = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  if (cookies.size > 0) headers.set('Cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '))
  if ((init.method ?? 'GET') !== 'GET') headers.set('Origin', dev.url)
  const response = await fetch(new URL(path, dev.url), { ...init, headers, redirect: 'manual' })
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split('; ')
    const [name, value] = pair!.split('=') as [string, string]
    cookies.set(name, value)
  }
  return response
}

const postJson = (path: string, body: unknown, csrf?: string) =>
  browse(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: JSON.stringify(body) })

const csrf = async () => ((await (await browse('/api/session')).json()) as { csrfToken: string }).csrfToken

beforeAll(async () => {
  dev = await startWranglerDev({ vars: { BOOTSTRAP_TOKEN: `e2e-${crypto.randomUUID()}`, SELF_SIGNUP: 'true' } })
  const authenticator = await createSoftAuthenticator({ origin: dev.url })
  const options = (await (await postJson('/login/passkey/register/options', { login: 'ada' })).json()) as { handle: string; publicKey: never }
  expect((await postJson('/login/passkey/register', { handle: options.handle, credential: await authenticator.create(options.publicKey) })).status).toBe(201)
  expect((await postJson('/api/repos', { owner: 'ada', name: 'notes', visibility: 'private' }, await csrf())).status).toBe(201)
}, 90_000)

afterAll(async () => {
  await dev?.stop()
})

describe('agent connection on wrangler dev', () => {
  it('connects a client through DCR, PKCE and the consent page, then pushes with a token from the MCP tool', async () => {
    const redirectUri = 'http://localhost:33418/callback'
    const challenge401 = await fetch(`${dev.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(challenge401.status).toBe(401)
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge401.headers.get('WWW-Authenticate')!)![1]!
    const resource = (await (await fetch(metadataUrl)).json()) as Json
    const server = (await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Json
    expect(server.issuer).toBe(dev.url)
    const client = (await (await fetch(server.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'e2e agent', redirect_uris: [redirectUri] }) })).json()) as Json
    const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
    const authorize = new URL(server.authorization_endpoint)
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', state: 's1', resource: resource.resource })) authorize.searchParams.set(key, value)
    const page = await browse(`${authorize.pathname}${authorize.search}`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Connect an agent')
    expect(html).toContain('e2e agent')
    const request = /name="request" value="([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&')
    const approved = await browse(authorize.pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: await csrf(), request, decision: 'approve', scope: 'repo:write', name: 'e2e on ci' }).toString(),
    })
    expect(approved.status).toBe(303)
    const callback = new URL(approved.headers.get('Location')!)
    expect(callback.searchParams.get('iss')).toBe(dev.url)
    const tokens = (await (
      await fetch(server.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: callback.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirectUri, resource: resource.resource }).toString(),
      })
    ).json()) as Json
    const call = async (method: string, params: Json) =>
      (await (
        await fetch(`${dev.url}/mcp`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
      ).json()) as Json
    expect((await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })).result.protocolVersion).toBe('2025-11-25')
    const issued = (await call('tools/call', { name: 'token', arguments: { scope: 'repo:write', repositories: ['ada/notes'], ttl_minutes: 10 } })).result.structuredContent as Json
    expect(issued).toMatchObject({ scope: 'repo:write', repositories: ['ada/notes'], login: 'ada' })

    const work = tempDir()
    const remote = new URL(`${dev.url}/ada/notes.git`)
    remote.username = 'agent'
    remote.password = issued.token
    await git(work, ['init', '-q', '-b', 'main'])
    writeFileSync(join(work, 'README.md'), 'pushed by an agent\n')
    await git(work, ['add', 'README.md'])
    await git(work, ['commit', '-qm', 'agent commit'])
    await git(work, ['push', '-q', remote.toString(), 'main'])
    const clone = tempDir()
    await git(clone, ['clone', '-q', remote.toString(), 'copy'])
    expect(await git(join(clone, 'copy'), ['log', '--format=%s'])).toContain('agent commit')

    const listed = (await (await browse('/settings')).text())
    expect(listed).toContain('Connected agents')
    expect(listed).toContain('e2e on ci')
    const id = /name="action" value="revoke-agent"\s*\/?>\s*<input type="hidden" name="id" value="([^"]+)"/.exec(listed)![1]!
    const revoked = await browse('/settings', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: await csrf(), action: 'revoke-agent', id }).toString() })
    expect(await revoked.text()).toContain('Agent disconnected')
    expect(await gitFails(clone, ['ls-remote', remote.toString()])).toMatch(/401|Authentication failed|invalid credentials/i)
  }, 60_000)
})
