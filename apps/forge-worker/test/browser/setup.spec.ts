import { expect, test } from '@playwright/test'
import { startServer } from '@git-forge/core/test/http-server.ts'
import { freePort, startWranglerDev } from '../e2e/wrangler-dev.ts'

test('sets up a fresh instance: claim admin, sign in with a passkey, configure OIDC, see the checks', async ({ page, context }) => {
  test.setTimeout(180_000)
  const token = `setup-${crypto.randomUUID()}`
  const port = await freePort()
  const origin = `http://localhost:${port}`
  const provider = await startServer(async (request) => {
    const issuer = new URL(request.url).origin
    return Response.json({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` })
  })
  const dev = await startWranglerDev({ port, vars: { BOOTSTRAP_TOKEN: token, PUBLIC_URL: origin } })
  try {
    const client = await context.newCDPSession(page)
    await client.send('WebAuthn.enable')
    await client.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })
    await page.goto(`${origin}/`)
    await expect(page.getByText('This instance has no admin yet.')).toBeVisible()
    await page.getByRole('link', { name: 'Set it up' }).click()
    await expect(page).toHaveURL(`${origin}/-/setup`)
    await page.getByLabel('BOOTSTRAP_TOKEN').fill('wrong')
    await page.getByLabel('Your login').fill('deployer')
    await page.getByRole('button', { name: 'Claim admin' }).click()
    await expect(page.getByRole('alert')).toHaveText('invalid bootstrap token')
    await page.getByLabel('BOOTSTRAP_TOKEN').fill(token)
    await page.getByLabel('Your login').fill('deployer')
    await page.getByRole('button', { name: 'Claim admin' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in as deployer' })).toBeVisible()
    await page.getByRole('link', { name: 'Open invite' }).click()
    await page.getByRole('button', { name: 'Use a passkey' }).click()
    await expect(page).toHaveURL(`${origin}/`)
    await page.goto(`${origin}/-/setup`)
    const checks = page.getByRole('region', { name: 'Checks' })
    await expect(checks.getByText('D1 location')).toBeVisible()
    await expect(checks.getByText('R2 location')).toBeVisible()
    await expect(checks.locator('[data-check="presigned-lfs"]')).toContainText('R2_SECRET_ACCESS_KEY')
    await expect(checks.locator('[data-check="queues"]')).toContainText('imports present, jobs present.')
    await expect(checks.locator('[data-check="actions"]')).toContainText('On, with runner containers.')
    const oidc = page.getByRole('form', { name: 'OIDC provider' })
    await oidc.getByLabel('Issuer').fill(provider.url)
    await oidc.getByLabel('Client id').fill('forge')
    await oidc.getByLabel(/Client secret/).fill('s3cret')
    await oidc.getByLabel('Button label').fill('Test ID')
    await oidc.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('status')).toHaveText('Sign-in with Test ID is configured.')
    await expect(checks.locator('[data-check="oidc"]')).toContainText('Configured here.')
    await page.getByRole('link', { name: 'Instance administration' }).last().click()
    await expect(page).toHaveURL(`${origin}/-/admin`)
    await expect(page.getByRole('region', { name: 'Updates' })).toContainText('Running')
    await expect(page.getByRole('region', { name: 'Storage and cost' })).toContainText('Workers Paid plan')
    await context.clearCookies()
    await page.goto(`${origin}/login`)
    await expect(page.getByRole('link', { name: /Test ID/ })).toBeVisible()
  } finally {
    await dev.stop()
    await provider.close()
  }
})
