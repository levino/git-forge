import { createServer } from 'node:http'
import { expect, test } from '@playwright/test'
import { base, signUpWithPasskey } from './support.ts'

test('connects an agent through the consent page and redirects to its loopback callback', async ({ page, context }, info) => {
  await signUpWithPasskey(page, context, `agent-${info.project.name}`)
  let received: URLSearchParams | null = null
  const server = createServer((request, response) => {
    received = new URL(request.url ?? '/', 'http://localhost').searchParams
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Agent connected</h1>')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`
    const registered = await fetch(`${base()}/login/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Playwright agent', redirect_uris: [redirectUri] }) })
    const { client_id: clientId } = (await registered.json()) as { client_id: string }
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 'pw', scope: 'repo:admin', resource: `${base()}/mcp` })
    await page.goto(`${base()}/login/oauth/authorize?${query}`)
    await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible()
    await expect(page.getByText('Playwright agent wants to act as')).toBeVisible()
    await page.locator('input[name=scope][value="repo:read"]').check()
    await page.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByRole('heading', { name: 'Agent connected' })).toBeVisible()
    expect(received!.get('state')).toBe('pw')
    const token = await fetch(`${base()}/login/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: received!.get('code')!, code_verifier: verifier, redirect_uri: redirectUri, resource: `${base()}/mcp` }).toString(),
    })
    expect(await token.json()).toMatchObject({ scope: 'repo:read', token_type: 'Bearer' })
    await page.goto(`${base()}/settings`)
    await expect(page.getByRole('heading', { name: 'Connected agents' })).toBeVisible()
    await page.getByRole('button', { name: 'Disconnect Playwright agent' }).click()
    await expect(page.getByText('Agent disconnected')).toBeVisible()
  } finally {
    server.close()
  }
})
