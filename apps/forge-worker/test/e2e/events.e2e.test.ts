import { createHash, createHmac } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const BOOTSTRAP_TOKEN = `e2e-${crypto.randomUUID()}`
const HOOK_SECRET = 'e2e-hook-secret'

type Captured = { readonly path: string; readonly headers: IncomingHttpHeaders; readonly body: string }

type Receiver = { readonly url: string; readonly requests: Captured[]; status: number; close(): Promise<void> }

const startReceiver = async (respond: (request: Captured) => { status: number; body: string }): Promise<Receiver> => {
  const requests: Captured[] = []
  const receiver = { status: 200 } as Receiver & { status: number }
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const captured = { path: request.url ?? '/', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(captured)
      const answer = respond(captured)
      response.writeHead(answer.status, { 'Content-Type': 'application/json' })
      response.end(answer.body)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return Object.assign(receiver, {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done())),
  })
}

let dev: WranglerDev
let hooks: Receiver
let ses: Receiver
let admin = ''
let bob = ''

const call = (path: string, init: RequestInit = {}, token = admin) =>
  fetch(`${dev.url}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
  })

const expectStatus = async (response: Promise<Response>, status: number): Promise<Response> => {
  const resolved = await response
  if (resolved.status !== status) throw new Error(`expected ${status}, got ${resolved.status}: ${await resolved.text()}\n${dev.output().slice(-3000)}`)
  return resolved
}

const eventsOf = (name: string) => hooks.requests.filter((request) => request.headers['x-github-event'] === name)

const waitFor = async <T>(probe: () => T | undefined | null | false, what: string, timeout = 30_000): Promise<T> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value
    await new Promise((done) => setTimeout(done, 200))
  }
  throw new Error(`timed out waiting for ${what}\n${dev.output().slice(-4000)}`)
}

beforeAll(async () => {
  let failNext = 0
  hooks = await startReceiver(() => (failNext-- > 0 ? { status: 500, body: '{"error":"busy"}' } : { status: 200, body: '{"ok":true}' }))
  Object.defineProperty(hooks, 'failNext', { set: (value: number) => (failNext = value) })
  ses = await startReceiver(() => ({ status: 200, body: JSON.stringify({ MessageId: `ses-${crypto.randomUUID()}` }) }))
  dev = await startWranglerDev({
    vars: {
      BOOTSTRAP_TOKEN,
      ALLOW_INSECURE_WEBHOOKS: 'true',
      EMAIL_PROVIDER: 'ses',
      EMAIL_FROM: 'Forge <forge@example.org>',
      SES_REGION: 'eu-central-1',
      SES_ACCESS_KEY_ID: 'AKIDE2E',
      SES_SECRET_ACCESS_KEY: 'e2e-secret',
      SES_ENDPOINT: ses.url,
    },
  })
  const bootstrapped = await expectStatus(call('/api/bootstrap', { method: 'POST', body: JSON.stringify({ login: 'e2e', email: 'e2e@example.org' }) }, BOOTSTRAP_TOKEN), 201)
  admin = ((await bootstrapped.json()) as { token: string }).token
  await expectStatus(call('/api/admin/users', { method: 'POST', body: JSON.stringify({ login: 'bob', email: 'bob@example.org' }) }), 201)
  bob = ((await (await expectStatus(call('/api/admin/users/bob/tokens', { method: 'POST', body: JSON.stringify({ scopes: ['repo:read'] }) }), 201)).json()) as { token: string }).token
  await expectStatus(call('/api/repos', { method: 'POST', body: JSON.stringify({ owner: 'e2e', name: 'engine' }) }), 201)
  await expectStatus(call('/api/repos/e2e/engine/collaborators/bob', { method: 'PUT', body: JSON.stringify({ role: 'read' }) }), 200)
}, 120_000)

afterAll(async () => {
  await dev?.stop()
  await hooks?.close()
  await ses?.close()
})

describe('notifications, webhooks, email and releases on wrangler dev', () => {
  let hookId = 0
  let head = ''

  it('creates a webhook and delivers a signed ping through the job queue', async () => {
    const created = await expectStatus(
      call('/api/v3/repos/e2e/engine/hooks', {
        method: 'POST',
        body: JSON.stringify({ name: 'web', config: { url: `${hooks.url}/forge`, content_type: 'json', secret: HOOK_SECRET }, events: ['push', 'release', 'create'] }),
      }),
      201,
    )
    hookId = ((await created.json()) as { id: number }).id
    const ping = await waitFor(() => eventsOf('ping')[0], 'ping delivery')
    expect(ping.path).toBe('/forge')
    expect(ping.headers['x-hub-signature-256']).toBe(`sha256=${createHmac('sha256', HOOK_SECRET).update(ping.body).digest('hex')}`)
    expect(ping.headers['user-agent']).toMatch(/^GitHub-Hookshot\//)
    expect(JSON.parse(ping.body)).toMatchObject({ hook_id: hookId, hook: { id: hookId, events: ['push', 'release', 'create'] }, repository: { full_name: 'e2e/engine' } })
  })

  it('sends push webhooks and emails a watching collaborator through SES', async () => {
    await expectStatus(call('/api/v3/repos/e2e/engine/subscription', { method: 'PUT', body: JSON.stringify({ subscribed: true }) }, bob), 200)
    await expectStatus(call('/api/v3/user/notification-settings', { method: 'PATCH', body: JSON.stringify({ email_watching: true }) }, bob), 200)
    const repo = tempDir()
    await git(repo, ['init', '-q', '-b', 'main'])
    writeFileSync(join(repo, 'README.md'), '# Engine\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'Start the engine'])
    head = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    await git(repo, ['push', '-q', `${dev.url.replace('http://', `http://git:${admin}@`)}/e2e/engine.git`, 'main'])

    const push = await waitFor(() => eventsOf('push')[0], 'push delivery')
    expect(push.headers['x-hub-signature-256']).toBe(`sha256=${createHmac('sha256', HOOK_SECRET).update(push.body).digest('hex')}`)
    expect(push.headers['x-github-delivery']).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(push.body)).toMatchObject({
      ref: 'refs/heads/main',
      after: head,
      created: true,
      commits: [{ id: head, message: 'Start the engine' }],
      sender: { login: 'e2e' },
      repository: { full_name: 'e2e/engine', private: true },
    })
    expect(eventsOf('create').map((request) => JSON.parse(request.body).ref)).toEqual(['main'])

    const inbox = (await (await expectStatus(call('/api/v3/notifications', {}, bob), 200)).json()) as { reason: string; subject: { type: string } }[]
    expect(inbox).toEqual([expect.objectContaining({ reason: 'subscribed', subject: expect.objectContaining({ type: 'Commit' }) })])

    const mail = await waitFor(() => ses.requests[0], 'SES SendEmail call')
    expect(mail.path).toBe('/v2/email/outbound-emails')
    expect(mail.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDE2E\/\d{8}\/eu-central-1\/ses\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/)
    const body = JSON.parse(mail.body) as { FromEmailAddress: string; Destination: { ToAddresses: string[] }; Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } } }
    expect(body.FromEmailAddress).toBe('Forge <forge@example.org>')
    expect(body.Destination.ToAddresses).toEqual(['bob@example.org'])
    expect(body.Content.Simple.Subject.Data).toBe('[e2e/engine] 1 new commit on main')
    expect(body.Content.Simple.Body.Text.Data).toContain(`/e2e/engine/commit/${head}`)
  })

  it('lists deliveries and redelivers one with the same delivery id', async () => {
    const deliveries = (await (await expectStatus(call(`/api/v3/repos/e2e/engine/hooks/${hookId}/deliveries`), 200)).json()) as { id: number; guid: string; event: string; status: string }[]
    const push = deliveries.find((delivery) => delivery.event === 'push')!
    expect(push.status).toBe('OK')
    const before = hooks.requests.length
    ;(hooks as unknown as { failNext: number }).failNext = 1
    await expectStatus(call(`/api/v3/repos/e2e/engine/hooks/${hookId}/deliveries/${push.id}/attempts`, { method: 'POST' }), 202)
    const redelivered = await waitFor(() => hooks.requests.slice(before).find((request) => request.headers['x-github-delivery'] === push.guid), 'redelivery')
    expect(redelivered.headers['x-github-event']).toBe('push')
    const listed = (await (await call(`/api/v3/repos/e2e/engine/hooks/${hookId}/deliveries`)).json()) as { redelivery: boolean; status: string; attempts: number }[]
    expect(listed[0]).toMatchObject({ redelivery: true, status: 'retrying: HTTP 500', attempts: 1 })
  })

  it('publishes a release, stores its asset in R2 and serves it through the media URL', async () => {
    const created = await expectStatus(call('/api/v3/repos/e2e/engine/releases', { method: 'POST', body: JSON.stringify({ tag_name: 'v1.0.0', name: 'First', body: 'Notes' }) }), 201)
    const release = (await created.json()) as { id: number; upload_url: string }
    const asset = new Uint8Array(300_000).map((_, i) => (i * 13) % 251)
    const oid = createHash('sha256').update(asset).digest('hex')
    const uploadUrl = release.upload_url.replace('{?name,label}', '?name=engine-linux.tar.gz&label=Linux')
    const uploaded = await expectStatus(
      fetch(uploadUrl, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/gzip' }, body: asset }),
      201,
    )
    const described = (await uploaded.json()) as { browser_download_url: string; digest: string; size: number }
    expect(described).toMatchObject({ digest: `sha256:${oid}`, size: asset.length, browser_download_url: `${dev.url}/e2e/engine/releases/download/v1.0.0/engine-linux.tar.gz` })
    const redirect = await expectStatus(fetch(described.browser_download_url, { headers: { Authorization: `Bearer ${bob}` }, redirect: 'manual' }), 302)
    expect(redirect.headers.get('Location')).toBe(`/e2e/engine/media/${oid}/engine-linux.tar.gz`)
    const media = await expectStatus(fetch(`${dev.url}${redirect.headers.get('Location')}`, { headers: { Authorization: `Bearer ${bob}` } }), 200)
    expect(media.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(asset)
    const tags = await git(tempDir(), ['ls-remote', '--tags', `${dev.url.replace('http://', `http://git:${admin}@`)}/e2e/engine.git`])
    expect(tags).toContain(`${head}\trefs/tags/v1.0.0`)
    const published = await waitFor(() => eventsOf('release').find((request) => JSON.parse(request.body).action === 'published'), 'release webhook')
    expect(JSON.parse(published.body)).toMatchObject({ release: { tag_name: 'v1.0.0', name: 'First' }, repository: { full_name: 'e2e/engine' } })
    const listed = (await (await expectStatus(call('/api/v3/repos/e2e/engine/releases', {}, bob), 200)).json()) as { tag_name: string; assets: { name: string; download_count: number }[] }[]
    expect(listed).toEqual([expect.objectContaining({ tag_name: 'v1.0.0', assets: [expect.objectContaining({ name: 'engine-linux.tar.gz', download_count: 1 })] })])
  })
})
