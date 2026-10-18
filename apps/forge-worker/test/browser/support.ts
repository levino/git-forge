import { expect, type BrowserContext, type Page } from '@playwright/test'

export const base = (): string => process.env.FORGE_URL!.replace('127.0.0.1', 'localhost')

export const invite = async (login: string): Promise<string> => {
  const response = await fetch(`${process.env.FORGE_URL}/api/admin/invites`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.FORGE_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login }),
  })
  expect(response.status).toBe(201)
  const { url } = (await response.json()) as { url: string }
  return new URL(url).pathname
}

export const signUpWithPasskey = async (page: Page, context: BrowserContext, login: string): Promise<void> => {
  const client = await context.newCDPSession(page)
  await client.send('WebAuthn.enable')
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  await page.goto(`${base()}${await invite(login)}`)
  await page.getByRole('button', { name: 'Use a passkey' }).click()
  await expect(page).toHaveURL(`${base()}/`)
}
