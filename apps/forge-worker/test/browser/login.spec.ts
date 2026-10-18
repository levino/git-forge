import { expect, test } from '@playwright/test'

const base = (): string => process.env.FORGE_URL!.replace('127.0.0.1', 'localhost')

const invite = async (login: string): Promise<string> => {
  const response = await fetch(`${process.env.FORGE_URL}/api/admin/invites`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.FORGE_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login }),
  })
  expect(response.status).toBe(201)
  const { url } = (await response.json()) as { url: string }
  return new URL(url).pathname
}

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

  await page.getByLabel('Name').fill('laptop')
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

test('creates a repository from the navbar and shows how to push into it', async ({ page, context }, info) => {
  const client = await context.newCDPSession(page)
  await client.send('WebAuthn.enable')
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  const login = `maker-${info.project.name}`
  await page.goto(`${base()}${await invite(login)}`)
  await page.getByRole('button', { name: 'Use a passkey' }).click()
  await expect(page).toHaveURL(`${base()}/`)
  await page.getByRole('link', { name: 'New repository' }).first().click()
  await expect(page.getByRole('heading', { name: 'New repository' })).toBeVisible()
  const form = page.getByRole('form', { name: 'Create a repository' })
  await expect(form.getByLabel('Owner')).toHaveValue(login)
  await form.getByLabel('Repository name').fill('notes')
  await form.getByRole('button', { name: 'Create repository' }).click()
  await expect(page).toHaveURL(`${base()}/${login}/notes`)
  await expect(page.getByRole('heading', { name: 'This repository is empty' })).toBeVisible()
  await expect(page.getByLabel('Clone over HTTPS').last()).toHaveValue(`${base()}/${login}/notes.git`)
  await expect(page.getByText('git push -u origin main')).toBeVisible()
})

test('refuses a cross-site token form', async ({ request }) => {
  const response = await request.post(`${base()}/settings`, { headers: { Origin: 'https://evil.example' }, form: { action: 'create-token', name: 'x', scopes: 'repo:admin', expires: 'never' } })
  expect(response.status()).toBe(403)
})
