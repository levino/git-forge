import { expect, test } from '@playwright/test'

const forge = (): string => process.env.FORGE_URL!.replace('127.0.0.1', 'localhost')

const pagesSite = (): string => `http://octo.pages.localhost:${new URL(process.env.FORGE_URL!).port}/hidden/`

const admin = (method: string, path: string, body: unknown) =>
  fetch(`${process.env.FORGE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.FORGE_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

test('hands the forge session over to a private pages site', async ({ page, context, browser }, info) => {
  const client = await context.newCDPSession(page)
  await client.send('WebAuthn.enable')
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  const login = `reader-${info.project.name}`
  const invite = await admin('POST', '/api/admin/invites', { login })
  expect(invite.status).toBe(201)
  await page.goto(`${forge()}${new URL(((await invite.json()) as { url: string }).url).pathname}`)
  await page.getByRole('button', { name: 'Use a passkey' }).click()
  await expect(page).toHaveURL(`${forge()}/`)

  await page.goto(`${pagesSite()}README.md`)
  await expect(page.locator('body')).toContainText('site not found')

  expect((await admin('PUT', `/api/repos/octo/hidden/collaborators/${login}`, { role: 'read' })).status).toBe(200)
  await page.goto(`${pagesSite()}README.md`)
  await expect(page).toHaveURL(`${pagesSite()}README.md`)
  await expect(page.locator('body')).toContainText('Pictures live in')
  const cookies = await context.cookies(pagesSite())
  expect(cookies.find((cookie) => cookie.name === 'forge_pages')).toMatchObject({ httpOnly: true, sameSite: 'Lax', domain: `octo.pages.localhost` })

  const stranger = await browser.newContext()
  const anonymous = await stranger.newPage()
  await anonymous.goto(`${pagesSite()}README.md`)
  await expect(anonymous).toHaveURL(/\/login\?return_to=%2F_pages%2Fauthorize/)
  await stranger.close()
})
