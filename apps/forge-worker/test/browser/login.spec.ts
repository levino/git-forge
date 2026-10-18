import { base, invite } from './support.ts'
import { expect, test } from '@playwright/test'

test('signs up with a passkey from an invite, manages tokens and signs out', async ({ page, context }, info) => {
  const client = await context.newCDPSession(page)
  await client.send('WebAuthn.enable')
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  const login = `user-${info.project.name}`
  await page.goto(`${base()}${await invite(login)}`)
  await expect(page.getByRole('heading', { name: 'Accept invite' })).toBeVisible()
  await page.getByRole('button', { name: 'Use a passkey' }).click()
  await expect(page).toHaveURL(`${base()}/`)
  await expect(page.getByRole('heading', { name: 'Your repositories' })).toBeVisible()

  await page.getByLabel(`Account menu (${login})`).click()
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: `Settings for ${login}` })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Passkeys' }).getByRole('button', { name: /Remove passkey/ })).toHaveCount(1)

  await page.getByLabel('Name', { exact: true }).fill('laptop')
  await page.getByRole('button', { name: 'Create token' }).click()
  const token = await page.getByLabel('Your new token').inputValue()
  expect(token).toMatch(/^gfp_/)
  const user = await fetch(`${process.env.FORGE_URL}/api/user`, { headers: { Authorization: `Bearer ${token}` } })
  expect(await user.json()).toMatchObject({ login })
  await page.getByRole('button', { name: 'Revoke laptop' }).click()
  await expect(page.getByText('Token revoked.')).toBeVisible()
  expect((await fetch(`${process.env.FORGE_URL}/api/user`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)

  await page.getByLabel(`Account menu (${login})`).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.goto(`${base()}/settings`)
  await expect(page).toHaveURL(/\/login\?return_to=%2Fsettings$/)
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(page).toHaveURL(`${base()}/settings`)
})

test('refuses a cross-site token form', async ({ request }) => {
  const response = await request.post(`${base()}/settings`, { headers: { Origin: 'https://evil.example' }, form: { action: 'create-token', name: 'x', scope: 'repo:admin', expires: 'never' } })
  expect(response.status()).toBe(403)
})
