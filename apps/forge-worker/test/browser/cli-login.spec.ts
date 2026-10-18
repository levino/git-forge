import { createServer } from 'node:http'
import { expect, test } from '@playwright/test'
import { base, signUpWithPasskey } from './support.ts'

const pkce = async () => {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')
  return { verifier, challenge }
}

const start = async (fields: Record<string, string>): Promise<string> => {
  const response = await fetch(`${base()}/login/cli/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'git-forge-cli', client_host: 'playwright', ...fields }).toString(),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { authorization_url: string }).authorization_url
}

const exchange = async (fields: Record<string, string>) =>
  (await (
    await fetch(`${base()}/login/cli/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'git-forge-cli', ...fields }).toString(),
    })
  ).json()) as Record<string, unknown>

test('approves a command line login and shows a code to paste', async ({ page, context }, info) => {
  await signUpWithPasskey(page, context, `cli-paste-${info.project.name}`)
  const { verifier, challenge } = await pkce()
  const link = await start({ redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', code_challenge: challenge, scope: 'repo:admin' })
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Authorize the command line' })).toBeVisible()
  await expect(page.getByText('playwright')).toBeVisible()
  await page.getByLabel('write (includes read)').check()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByRole('heading', { name: 'Paste this code' })).toBeVisible()
  const code = await page.getByLabel('Authorization code').inputValue()
  expect(code).toMatch(/^gfc_/)
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible()
  expect(await exchange({ code, code_verifier: verifier, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob' })).toMatchObject({ scope: 'repo:write' })
})

test('redirects an approved command line login to the loopback address', async ({ page, context }, info) => {
  await signUpWithPasskey(page, context, `cli-loopback-${info.project.name}`)
  let received: URLSearchParams | null = null
  const server = createServer((request, response) => {
    received = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Logged in</h1>')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const port = (server.address() as { port: number }).port
    const redirectUri = `http://127.0.0.1:${port}/callback`
    const { verifier, challenge } = await pkce()
    await page.goto(await start({ redirect_uri: redirectUri, code_challenge: challenge, state: 'pw-state' }))
    await page.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByRole('heading', { name: 'Logged in' })).toBeVisible()
    expect(received!.get('state')).toBe('pw-state')
    expect(await exchange({ code: received!.get('code')!, code_verifier: verifier, redirect_uri: redirectUri })).toMatchObject({ scope: 'repo:write' })
  } finally {
    server.close()
  }
})
