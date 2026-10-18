import { expect, type BrowserContext, type Page } from '@playwright/test'

export const base = (): string => process.env.FORGE_URL!.replace('127.0.0.1', 'localhost')

export const api = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${process.env.FORGE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.FORGE_ADMIN_TOKEN}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

export const invite = async (login: string, existing = false): Promise<string> => {
  const response = await api('POST', '/api/admin/invites', existing ? { user: login } : { login })
  expect(response.status).toBe(201)
  const { url } = (await response.json()) as { url: string }
  return new URL(url).pathname
}

export const signUpWithPasskey = async (page: Page, context: BrowserContext, login: string, existing = false): Promise<void> => {
  const client = await context.newCDPSession(page)
  await client.send('WebAuthn.enable')
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  await page.goto(`${base()}${await invite(login, existing)}`)
  await page.getByRole('button', { name: 'Use a passkey' }).click()
  await expect(page).toHaveURL(`${base()}/`)
}
