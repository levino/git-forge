import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

let dev: WranglerDev

beforeAll(async () => {
  dev = await startWranglerDev({ vars: { BOOTSTRAP_TOKEN: `headless-${crypto.randomUUID()}`, UI: 'false' } })
})

afterAll(async () => {
  await dev?.stop()
})

describe('the same bundle with UI=false', () => {
  it('serves only the forge', async () => {
    const root = await fetch(`${dev.url}/`)
    expect(root.headers.get('Content-Type')).toContain('application/json')
    expect(await root.json()).toEqual({ ok: true, service: 'git-forge' })
    expect((await fetch(`${dev.url}/explore`)).status).toBe(404)
    expect((await fetch(`${dev.url}/-/style.css`)).status).toBe(404)
  })
})

describe('the bundle with the UI', () => {
  it('renders pages and keeps the API', async () => {
    const ui = await startWranglerDev({ vars: { BOOTSTRAP_TOKEN: `ui-${crypto.randomUUID()}` } })
    try {
      const root = await fetch(`${ui.url}/`)
      expect(root.headers.get('Content-Type')).toContain('text/html')
      expect(await root.text()).toContain('<!DOCTYPE html>')
      expect(await (await fetch(`${ui.url}/api/health`)).json()).toEqual({ ok: true, service: 'git-forge' })
      const crossSite = await fetch(`${ui.url}/login`, { method: 'POST', headers: { Origin: 'https://evil.example' } })
      expect(crossSite.status).toBe(403)
    } finally {
      await ui.stop()
    }
  })
})
