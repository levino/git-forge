import { createMemoryEmailSender, type MemoryEmailSender, readRefs } from '@git-forge/core'
import { commitAll, initRepo, sampleHistory, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git } from '../e2e/history.ts'
import { ConfigurationError, parseEmailSettings, parseSettings } from '../../src/config.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

type Hook = { url: string; event: string | null; body: Record<string, unknown> }

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T

const hookFetch = (received: Hook[]) => async (request: Request) => {
  if (new URL(request.url).host !== 'hooks.example.com') return globalThis.fetch(request)
  received.push({ url: request.url, event: request.headers.get('X-GitHub-Event'), body: JSON.parse(await request.text()) as Record<string, unknown> })
  return new Response('ok')
}

describe('email and webhook settings', () => {
  it('parses the email provider from vars and secrets', async () => {
    expect(parseEmailSettings({})).toBeUndefined()
    expect(parseEmailSettings({ EMAIL_PROVIDER: 'none' })).toBeUndefined()
    expect(parseEmailSettings({ EMAIL_PROVIDER: 'console', EMAIL_FROM: 'forge@example.org' })).toEqual({ provider: 'console', from: 'forge@example.org' })
    expect(
      parseEmailSettings({ EMAIL_PROVIDER: 'ses', EMAIL_FROM: 'forge@example.org', SES_REGION: 'eu-west-1', SES_ACCESS_KEY_ID: 'AKID', SES_SECRET_ACCESS_KEY: 's', SES_ENDPOINT: '' }),
    ).toEqual({ provider: 'ses', from: 'forge@example.org', region: 'eu-west-1', accessKeyId: 'AKID', secretAccessKey: 's' })
    expect(() => parseEmailSettings({ EMAIL_PROVIDER: 'console' })).toThrow(ConfigurationError)
    expect(() => parseEmailSettings({ EMAIL_PROVIDER: 'ses', EMAIL_FROM: 'forge@example.org', SES_REGION: 'eu-west-1' })).toThrow('SES_ACCESS_KEY_ID')
    expect(() => parseEmailSettings({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'forge@example.org' })).toThrow('none, console, cloudflare or ses')
    expect(parseEmailSettings({}, true)).toBeUndefined()
    expect(parseEmailSettings({ PUBLIC_URL: 'https://git.example.org' }, true)).toEqual({ provider: 'cloudflare', from: 'Forge <forge@git.example.org>' })
    expect(parseEmailSettings({ EMAIL_FROM: 'a@example.org' }, true)).toEqual({ provider: 'cloudflare', from: 'a@example.org' })
    expect(parseEmailSettings({ EMAIL_PROVIDER: 'console', EMAIL_FROM: 'a@example.org' }, true)).toEqual({ provider: 'console', from: 'a@example.org' })
    expect(() => parseEmailSettings({ EMAIL_PROVIDER: 'cloudflare', EMAIL_FROM: 'a@example.org' })).toThrow('send_email binding')
    expect(() => parseEmailSettings({ EMAIL_PROVIDER: 'cloudflare' }, true)).toThrow('EMAIL_FROM')
    expect((await parseSettings({})).allowInsecureWebhooks).toBe(false)
    expect((await parseSettings({ ALLOW_INSECURE_WEBHOOKS: 'true' })).allowInsecureWebhooks).toBe(true)
  })
})

describe('events from pushes and releases', () => {
  let server: RunningServer
  let forge: NodeForge
  let admin: string
  let bob: string
  let email: MemoryEmailSender
  const received: Hook[] = []
  let source: string

  beforeAll(async () => {
    let handler = (_request: Request) => Promise.resolve(new Response('starting', { status: 503 }))
    server = await startServer((request) => handler(request))
    email = createMemoryEmailSender('forge@example.org')
    forge = await nodeForge({ publicUrl: server.url, email, fetch: hookFetch(received) })
    handler = forge.fetch
    admin = await bootstrap(forge, server.url, 'admin')
    await call(forge, server.url, 'POST', '/api/admin/users', admin, { login: 'bob', email: 'bob@example.org' })
    bob = (await json<{ token: string }>(await call(forge, server.url, 'POST', '/api/admin/users/bob/tokens', admin, { scopes: ['repo:read'] }))).token
    await call(forge, server.url, 'POST', '/api/repos', admin, { owner: 'admin', name: 'engine' })
    await call(forge, server.url, 'PUT', '/api/repos/admin/engine/collaborators/bob', admin, { role: 'read' })
    expect((await call(forge, server.url, 'PUT', '/api/v3/repos/admin/engine/subscription', bob, { subscribed: true })).status).toBe(200)
    await call(forge, server.url, 'PATCH', '/api/v3/user/notification-settings', bob, { email_watching: true })
    const hook = await call(forge, server.url, 'POST', '/api/v3/repos/admin/engine/hooks', admin, {
      config: { url: 'https://hooks.example.com/forge', content_type: 'json' },
      events: ['*'],
    })
    expect(hook.status).toBe(201)
    source = initRepo()
  })

  afterAll(async () => {
    await server.close()
  })

  const push = (args: string[]) => git(source, ['-c', `http.extraHeader=Authorization: Bearer ${admin}`, 'push', '-q', `${server.url}/admin/engine.git`, ...args])

  it('delivers push webhooks with the pushed commits and notifies watchers inline without a queue', async () => {
    sampleHistory(source, 3)
    await push(['main'])
    writeFile(source, 'NEWS', 'second push\n')
    const head = commitAll(source, 'Write the news')
    await push(['main'])
    const pushes = received.filter((hook) => hook.event === 'push')
    expect(pushes).toHaveLength(2)
    expect(received.filter((hook) => hook.event === 'create').map((hook) => hook.body.ref)).toEqual(['main'])
    expect((pushes[0]!.body.commits as unknown[]).length).toBe(3)
    expect(pushes[1]!.body).toMatchObject({
      ref: 'refs/heads/main',
      after: head,
      head_commit: { id: head, message: 'Write the news' },
      pusher: { name: 'admin' },
      sender: { login: 'admin' },
      repository: { full_name: 'admin/engine', default_branch: 'main' },
    })
    expect((pushes[1]!.body.commits as { id: string }[]).map((commit) => commit.id)).toEqual([head])
    const inbox = await json<{ reason: string; subject: { title: string; type: string } }[]>(await call(forge, server.url, 'GET', '/api/v3/notifications', bob))
    expect(inbox).toEqual([expect.objectContaining({ reason: 'subscribed', subject: expect.objectContaining({ type: 'Commit', title: '1 new commit on main' }) })])
    expect(email.sent.map((mail) => mail.to[0])).toEqual(['bob@example.org', 'bob@example.org'])
  })

  it('creates the tag of a release through the push pipeline and announces the release', async () => {
    const created = await call(forge, server.url, 'POST', '/api/v3/repos/admin/engine/releases', admin, { tag_name: 'v1.0.0', name: 'First' })
    expect(created.status).toBe(201)
    const tags = await git(source, ['ls-remote', '--tags', `${server.url.replace('://', `://git:${admin}@`)}/admin/engine.git`])
    expect(tags).toContain('refs/tags/v1.0.0')
    expect(received.slice(-5).map((hook) => [hook.event, hook.body.action ?? hook.body.ref])).toEqual([
      ['create', 'v1.0.0'],
      ['push', 'refs/tags/v1.0.0'],
      ['release', 'created'],
      ['release', 'published'],
      ['release', 'released'],
    ])
    const inbox = await json<{ subject: { type: string } }[]>(await call(forge, server.url, 'GET', '/api/v3/notifications?all=true', bob))
    expect(inbox.map((thread) => thread.subject.type).sort()).toEqual(['Commit', 'Commit', 'Release'])
  })

  it('emits issue, comment and pull request events and pushes merges through the push pipeline', async () => {
    const issue = await call(forge, server.url, 'POST', '/api/v3/repos/admin/engine/issues', admin, { title: 'Valve leaks', body: '@bob can you look?' })
    expect(issue.status).toBe(201)
    await call(forge, server.url, 'POST', '/api/v3/repos/admin/engine/issues/1/comments', admin, { body: 'Still leaking' })
    await git(source, ['checkout', '-q', '-b', 'fix'])
    writeFile(source, 'VALVE', 'tight\n')
    commitAll(source, 'Tighten the valve\n\nFixes #1')
    await git(source, ['checkout', '-q', 'main'])
    await push(['fix'])
    expect((await call(forge, server.url, 'POST', '/api/v3/repos/admin/engine/pulls', admin, { title: 'Tighten', head: 'fix', base: 'main' })).status).toBe(201)
    const merged = await call(forge, server.url, 'PUT', '/api/v3/repos/admin/engine/pulls/2/merge', admin, { merge_method: 'squash' })
    const sha = (await json<{ sha: string }>(merged)).sha
    const events = received.filter((hook) => ['issues', 'issue_comment', 'pull_request'].includes(hook.event ?? '')).map((hook) => [hook.event, hook.body.action])
    expect(events).toEqual([
      ['issues', 'opened'],
      ['issue_comment', 'created'],
      ['pull_request', 'opened'],
      ['pull_request', 'closed'],
      ['issues', 'closed'],
    ])
    expect(received.filter((hook) => hook.event === 'pull_request').at(-1)!.body).toMatchObject({ number: 2, pull_request: { merged: true, merge_commit_sha: sha } })
    expect(received.filter((hook) => hook.event === 'push').at(-1)!.body).toMatchObject({ ref: 'refs/heads/main', after: sha, pusher: { name: 'admin' } })
    const inbox = await json<{ reason: string; subject: { type: string; title: string } }[]>(await call(forge, server.url, 'GET', '/api/v3/notifications?all=true', bob))
    expect(inbox).toContainEqual(expect.objectContaining({ reason: 'mention', subject: expect.objectContaining({ type: 'Issue', title: 'Valve leaks' }) }))
  })

  it('keeps the existing JSON API and notification routes apart', async () => {
    expect((await call(forge, server.url, 'GET', '/api/v3/notifications')).status).toBe(401)
    expect((await call(forge, server.url, 'GET', '/api/v3/repos/admin/engine/hooks', bob)).status).toBe(403)
    expect((await call(forge, server.url, 'GET', '/api/health')).status).toBe(200)
  })
})

describe('mirror alarms', () => {
  let upstreamServer: RunningServer
  let downstreamServer: RunningServer
  let upstream: NodeForge
  let downstream: NodeForge

  beforeAll(async () => {
    let up = (_request: Request) => Promise.resolve(new Response('starting', { status: 503 }))
    let down = up
    upstreamServer = await startServer((request) => up(request))
    downstreamServer = await startServer((request) => down(request))
    upstream = await nodeForge({ publicUrl: upstreamServer.url })
    downstream = await nodeForge({ publicUrl: downstreamServer.url })
    up = upstream.fetch
    down = downstream.fetch
  })

  afterAll(async () => {
    await upstreamServer.close()
    await downstreamServer.close()
  })

  it('notifies the administrators of a mirror when upstream history is rewritten', async () => {
    const upstreamAdmin = await bootstrap(upstream, upstreamServer.url)
    const downstreamAdmin = await bootstrap(downstream, downstreamServer.url, 'keeper')
    await call(upstream, upstreamServer.url, 'POST', '/api/repos', upstreamAdmin, { owner: 'admin', name: 'archive', visibility: 'public' })
    const source = initRepo()
    sampleHistory(source, 2)
    const url = `${upstreamServer.url}/admin/archive.git`
    await git(source, ['-c', `http.extraHeader=Authorization: Bearer ${upstreamAdmin}`, 'push', '-q', url, 'main'])
    await call(downstream, downstreamServer.url, 'POST', '/api/repos', downstreamAdmin, { owner: 'keeper', name: 'archive' })
    expect((await call(downstream, downstreamServer.url, 'POST', '/api/repos/keeper/archive/mirrors', downstreamAdmin, { url, mode: 'manual' })).status).toBe(201)
    expect((await call(downstream, downstreamServer.url, 'POST', '/api/repos/keeper/archive/mirrors/origin/sync', downstreamAdmin)).status).toBe(200)
    await git(source, ['reset', '-q', '--hard', 'HEAD~1'])
    writeFile(source, 'REWRITE', 'rewritten\n')
    commitAll(source, 'Rewrite history')
    await git(source, ['-c', `http.extraHeader=Authorization: Bearer ${upstreamAdmin}`, 'push', '-q', '-f', url, 'main'])
    const synced = await json<{ alarms: unknown[] }>(await call(downstream, downstreamServer.url, 'POST', '/api/repos/keeper/archive/mirrors/origin/sync', downstreamAdmin))
    expect(synced.alarms).toHaveLength(1)
    const inbox = await json<{ reason: string; subject: { type: string; title: string } }[]>(await call(downstream, downstreamServer.url, 'GET', '/api/v3/notifications', downstreamAdmin))
    expect(inbox).toEqual([expect.objectContaining({ reason: 'security_alert', subject: expect.objectContaining({ type: 'MirrorAlarm', title: 'Upstream origin rewrote history (1 rewritten)' }) })])
    expect((await readRefs(downstream.storage, { owner: 'keeper', name: 'archive' }))?.state.refs['refs/upstream/origin/heads/main']).toBeDefined()
  })
})
