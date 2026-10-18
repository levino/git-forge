import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type EventContext,
  extractMentions,
  issueCommentEvent,
  issuesEvent,
  mirrorAlarmEvent,
  pushEvent,
  releaseEvent,
  workflowRunEvent,
} from '../src/events.ts'
import { resolveRecipients } from '../src/fanout.ts'
import { pushedCommits } from '../src/push.ts'
import { DEFAULT_SETTINGS } from '../src/store.ts'
import { validateWebhookUrl, verifySignature } from '../src/webhooks.ts'
import { BASE, type Fixture, setup } from './setup.ts'

const repository = { owner: 'alice', name: 'engine' }

const contextOf = (fixture: Fixture, login: 'alice' | 'bob' | 'carol' | 'dave'): EventContext => ({
  baseUrl: BASE,
  repository,
  actor: { kind: 'user', id: fixture.users[login].id, login },
})

const issue = (overrides: Partial<Parameters<typeof issuesEvent>[2]> = {}) => ({
  number: 1,
  title: 'Boiler leaks',
  body: 'Seen by @bob and @carol, not by `@dave`.',
  state: 'open' as const,
  author: 'alice',
  createdAt: '2026-10-18T10:00:00Z',
  updatedAt: '2026-10-18T10:00:00Z',
  ...overrides,
})

type Thread = { id: string; reason: string; unread: boolean; subject: { title: string; type: string }; repository: { full_name: string } }

const inbox = async (fixture: Fixture, login: 'alice' | 'bob' | 'carol' | 'dave', query = ''): Promise<Thread[]> => {
  const response = await fixture.api('GET', `/api/v3/notifications${query}`, login)
  expect(response.status).toBe(200)
  return (await response.json()) as Thread[]
}

describe('mentions', () => {
  it('finds @logins outside code and quotes, once each', () => {
    expect(extractMentions('Hi @ada and @Bob-1, cc @ada.\n> @quoted\n```\n@code\n```\nmail ada@example.org `@inline` @org/team')).toEqual(['ada', 'Bob-1'])
    expect(extractMentions(null)).toEqual([])
  })
})

describe('recipient rules', () => {
  const settings = new Map([['u-actor', DEFAULT_SETTINGS]])
  it('ranks reasons, honours ignores and skips the actor', () => {
    const recipients = resolveRecipients({
      eventName: 'issue_comment',
      audience: { watchers: 'all' },
      direct: [
        { userId: 'u-actor', reason: 'comment', subscribe: true },
        { userId: 'u-m', reason: 'mention', subscribe: true },
      ],
      admins: [],
      threadSubscribers: [
        { user_id: 'u-m', reason: 'author', ignored: 0 },
        { user_id: 'u-ignored', reason: 'author', ignored: 1 },
      ],
      watchers: [
        { user_id: 'u-w', level: 'all' },
        { user_id: 'u-r', level: 'releases' },
        { user_id: 'u-ignored', level: 'all' },
        { user_id: 'u-quiet', level: 'ignore' },
      ],
      actorId: 'u-actor',
      settings,
    })
    expect(recipients.map((recipient) => [recipient.userId, recipient.reason])).toEqual([
      ['u-m', 'mention'],
      ['u-w', 'subscribed'],
    ])
  })

  it('lets release watchers see releases only', () => {
    const base = { direct: [], admins: [], threadSubscribers: [], actorId: null, settings: new Map() }
    const watchers = [
      { user_id: 'u-all', level: 'all' as const },
      { user_id: 'u-rel', level: 'releases' as const },
    ]
    expect(resolveRecipients({ ...base, eventName: 'release', audience: { watchers: 'releases' }, watchers }).map((r) => r.userId)).toEqual(['u-all', 'u-rel'])
    expect(resolveRecipients({ ...base, eventName: 'push', audience: { watchers: 'all' }, watchers }).map((r) => r.userId)).toEqual(['u-all'])
  })
})

describe('push commits', () => {
  it('lists the new commits of a ref oldest first', () => {
    const commit = (id: string, parent: string | null, message: string) => ({
      id,
      type: 'commit' as const,
      offset: 0,
      crc32: 0,
      data: new TextEncoder().encode(`tree ${'t'.repeat(40)}\n${parent ? `parent ${parent}\n` : ''}author A <a@x.org> 1760781600 +0200\ncommitter A <a@x.org> 1760781600 +0200\n\n${message}\n`),
    })
    const old = 'a'.repeat(40)
    const objects = [commit('c'.repeat(40), 'b'.repeat(40), 'second'), commit('b'.repeat(40), old, 'first')]
    const commits = pushedCommits(objects, { oldId: old, newId: 'c'.repeat(40) })
    expect(commits.map((entry) => entry.message)).toEqual(['first', 'second'])
    expect(commits[0]!.timestamp).toBe('2025-10-18T12:00:00+02:00')
    expect(commits[0]!.author).toEqual({ name: 'A', email: 'a@x.org' })
  })
})

describe('webhook URLs', () => {
  it('requires public https unless insecure delivery is allowed', () => {
    expect(validateWebhookUrl('https://hooks.example.com/x', { allowInsecure: false })).toBeNull()
    expect(validateWebhookUrl('http://hooks.example.com/x', { allowInsecure: false })).toBe('url must use https')
    for (const host of ['127.0.0.1', 'localhost', '10.1.2.3', '192.168.0.1', '[::1]', '169.254.169.254', 'printer.local']) {
      expect(validateWebhookUrl(`https://${host}/x`, { allowInsecure: false })).toBe('url must not point to a private or local address')
    }
    expect(validateWebhookUrl('http://127.0.0.1:8080/x', { allowInsecure: true })).toBeNull()
    expect(validateWebhookUrl('https://user:pw@hooks.example.com/', { allowInsecure: true })).toBe('url must not contain credentials')
    expect(validateWebhookUrl('ftp://hooks.example.com/', { allowInsecure: true })).toBe('url must use http or https')
  })
})

describe('notification inbox', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await setup()
  })

  it('notifies mentioned readers, the author on replies and watchers, never users without access', async () => {
    expect((await fixture.api('PUT', '/api/v3/repos/alice/engine/subscription', 'dave', { subscribed: true })).status).toBe(200)
    expect((await fixture.api('PUT', '/api/v3/repos/alice/engine/subscription', 'carol', { subscribed: true })).status).toBe(404)
    await fixture.notifications.emit(issuesEvent(contextOf(fixture, 'alice'), 'opened', issue()))
    await fixture.queue.drain()
    expect(await inbox(fixture, 'alice')).toEqual([])
    expect((await inbox(fixture, 'bob')).map((thread) => thread.reason)).toEqual(['mention'])
    expect(await inbox(fixture, 'carol')).toEqual([])
    const [watched] = await inbox(fixture, 'dave')
    expect(watched).toMatchObject({ reason: 'subscribed', unread: true, subject: { title: 'Boiler leaks', type: 'Issue' }, repository: { full_name: 'alice/engine' } })

    fixture.clock.now += 1000
    await fixture.notifications.emit(
      issueCommentEvent(contextOf(fixture, 'bob'), 'created', issue(), { id: 7, body: 'Fixed the valve.', author: 'bob', createdAt: fixture.clock.now, updatedAt: fixture.clock.now }),
    )
    await fixture.queue.drain()
    expect((await inbox(fixture, 'alice')).map((thread) => thread.reason)).toEqual(['author'])
    expect((await inbox(fixture, 'bob')).map((thread) => thread.reason)).toEqual(['mention'])
    expect(await inbox(fixture, 'dave', '?participating=true')).toEqual([])
  })

  it('marks threads read, lists all, and stops after ignoring a thread', async () => {
    await fixture.notifications.emit(issuesEvent(contextOf(fixture, 'alice'), 'opened', issue()))
    await fixture.queue.drain()
    const [thread] = await inbox(fixture, 'bob')
    expect((await fixture.api('PATCH', `/api/v3/notifications/threads/${thread!.id}`, 'bob')).status).toBe(205)
    expect(await inbox(fixture, 'bob')).toEqual([])
    expect((await inbox(fixture, 'bob', '?all=true'))[0]!.unread).toBe(false)
    expect((await fixture.api('PATCH', `/api/v3/notifications/threads/${thread!.id}`, 'alice')).status).toBe(404)
    expect((await fixture.api('PUT', `/api/v3/notifications/threads/${thread!.id}/subscription`, 'bob', { ignored: true })).status).toBe(200)
    fixture.clock.now += 1000
    await fixture.notifications.emit(issueCommentEvent(contextOf(fixture, 'alice'), 'created', issue(), { id: 8, body: '@bob ping', author: 'alice', createdAt: 1, updatedAt: 1 }))
    await fixture.queue.drain()
    expect(await inbox(fixture, 'bob')).toEqual([])
    expect((await fixture.api('PUT', '/api/v3/notifications', 'bob', {})).status).toBe(202)
    expect((await fixture.api('GET', '/api/v3/notifications', null)).status).toBe(401)
  })

  it('raises mirror alarms for repository admins and CI results for the triggering user', async () => {
    await fixture.notifications.emit(
      mirrorAlarmEvent(
        { baseUrl: BASE, repository, actor: { kind: 'system', id: null, login: null } },
        {
          remote: 'origin',
          upstream: 'https://upstream.example.org/alice/engine',
          alarms: [{ kind: 'history-rewritten', ref: 'refs/heads/main', localRef: 'refs/upstream/origin/heads/main', oldId: 'a'.repeat(40), newId: 'b'.repeat(40), archivedAs: 'refs/archive/1/x', at: '2026-10-18T10:00:00Z' }],
        },
      ),
    )
    await fixture.notifications.emit(
      workflowRunEvent(contextOf(fixture, 'bob'), 'completed', {
        id: 3,
        name: 'CI',
        path: '.github/workflows/ci.yml',
        event: 'push',
        status: 'completed',
        conclusion: 'failure',
        headBranch: 'main',
        headSha: 'c'.repeat(40),
        actor: 'bob',
        createdAt: 1,
        updatedAt: 2,
      }),
    )
    await fixture.queue.drain()
    expect((await inbox(fixture, 'alice')).map((thread) => [thread.reason, thread.subject.type, thread.subject.title])).toEqual([
      ['security_alert', 'MirrorAlarm', 'Upstream origin rewrote history (1 rewritten)'],
    ])
    expect(await inbox(fixture, 'bob')).toEqual([])
    await fixture.api('PATCH', '/api/v3/user/notification-settings', 'bob', { own_activity: true })
    await fixture.notifications.emit(
      workflowRunEvent(contextOf(fixture, 'bob'), 'completed', {
        id: 4,
        name: 'CI',
        path: '.github/workflows/ci.yml',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        headBranch: 'main',
        headSha: 'c'.repeat(40),
        actor: 'bob',
        createdAt: 1,
        updatedAt: 2,
      }),
    )
    await fixture.queue.drain()
    expect((await inbox(fixture, 'bob')).map((thread) => [thread.reason, thread.subject.title])).toEqual([['ci_activity', 'CI workflow run succeeded for main']])
  })

  it('validates and stores per-user settings', async () => {
    expect(await (await fixture.api('GET', '/api/v3/user/notification-settings', 'bob')).json()).toEqual({
      email: 'instant',
      email_participating: true,
      email_watching: false,
      own_activity: false,
      email_address: null,
    })
    expect((await fixture.api('PATCH', '/api/v3/user/notification-settings', 'bob', { email: 'weekly' })).status).toBe(422)
    expect((await fixture.api('PATCH', '/api/v3/user/notification-settings', 'bob', { email_address: 'nope' })).status).toBe(422)
    const updated = await fixture.api('PATCH', '/api/v3/user/notification-settings', 'bob', { email: 'daily', email_watching: true, email_address: 'b@work.example.org' })
    expect(await updated.json()).toMatchObject({ email: 'daily', email_watching: true, email_address: 'b@work.example.org' })
  })
})

describe('email digests', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await setup()
  })

  it('sends one email per instant notification batch to participating users', async () => {
    await fixture.notifications.emit(issuesEvent(contextOf(fixture, 'alice'), 'opened', issue()))
    await fixture.queue.drain()
    expect(fixture.email.sent.map((mail) => [mail.to, mail.subject])).toEqual([[['bob@example.org'], '[alice/engine] Boiler leaks']])
    expect(fixture.email.sent[0]!.text).toContain(`${BASE}/alice/engine/issues/1`)
    expect(fixture.email.sent[0]!.headers?.['List-Unsubscribe']).toBe(`<${BASE}/settings/notifications>`)
  })

  it('collects notifications into a daily digest, sent once', async () => {
    await fixture.api('PATCH', '/api/v3/user/notification-settings', 'bob', { email: 'daily' })
    await fixture.notifications.emit(issuesEvent(contextOf(fixture, 'alice'), 'opened', issue()))
    fixture.clock.now += 1000
    await fixture.notifications.emit(issuesEvent(contextOf(fixture, 'alice'), 'opened', issue({ number: 2, title: 'Chimney', body: '@bob look' })))
    const start = fixture.clock.now
    await fixture.queue.drain()
    expect(fixture.email.sent).toHaveLength(1)
    expect(fixture.email.sent[0]!.subject).toBe('[forge.example.org] 2 new notifications')
    expect(fixture.clock.now - start).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 2000)
    await fixture.notifications.sweep()
    await fixture.queue.drain()
    expect(fixture.email.sent).toHaveLength(1)
  })

  it('sends nothing when email is off or only watching', async () => {
    await fixture.api('PATCH', '/api/v3/user/notification-settings', 'bob', { email: 'off' })
    await fixture.api('PUT', '/api/v3/repos/alice/engine/subscription', 'dave', { subscribed: true })
    await fixture.notifications.emit(issuesEvent(contextOf(fixture, 'alice'), 'opened', issue()))
    await fixture.queue.drain()
    expect(fixture.email.sent).toHaveLength(0)
  })
})

describe('webhooks', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await setup()
  })

  const createHook = async (body: Record<string, unknown> = {}) => {
    const response = await fixture.api('POST', '/api/v3/repos/alice/engine/hooks', 'alice', {
      name: 'web',
      config: { url: 'https://hooks.example.com/forge', content_type: 'json', secret: 's3cret' },
      events: ['push', 'release'],
      ...body,
    })
    expect(response.status).toBe(201)
    await fixture.queue.drain()
    return (await response.json()) as { id: number; config: Record<string, string>; events: string[] }
  }

  const push = () =>
    pushEvent(contextOf(fixture, 'bob'), {
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      forced: false,
      commits: [{ id: 'b'.repeat(40), message: 'Fix', timestamp: '2026-10-18T12:00:00+02:00', author: { name: 'Bob', email: 'bob@example.org' }, committer: { name: 'Bob', email: 'bob@example.org' } }],
      pusher: { name: 'bob', email: 'bob@example.org' },
    })

  it('needs repository admin rights to manage hooks', async () => {
    expect((await fixture.api('GET', '/api/v3/repos/alice/engine/hooks', 'bob')).status).toBe(403)
    expect((await fixture.api('GET', '/api/v3/repos/alice/engine/hooks', 'carol')).status).toBe(404)
    expect((await fixture.api('POST', '/api/v3/repos/alice/engine/hooks', 'alice', { config: { url: 'http://10.0.0.1/' } })).status).toBe(422)
    expect((await fixture.api('POST', '/api/v3/repos/alice/engine/hooks', 'alice', { config: { url: 'https://hooks.example.com' }, events: ['nope'] })).status).toBe(422)
  })

  it('pings on creation and delivers signed GitHub-compatible push payloads', async () => {
    const hook = await createHook()
    expect(hook.config).toEqual({ url: 'https://hooks.example.com/forge', content_type: 'json', insecure_ssl: '0', secret: '********' })
    expect(fixture.received.map((request) => request.headers.get('X-GitHub-Event'))).toEqual(['ping'])
    await fixture.notifications.emit(push())
    await fixture.notifications.emit(issuesEvent(contextOf(fixture, 'alice'), 'opened', issue()))
    await fixture.queue.drain()
    expect(fixture.received.map((request) => request.headers.get('X-GitHub-Event'))).toEqual(['ping', 'push'])
    const delivered = fixture.received[1]!
    expect(delivered.headers.get('User-Agent')).toMatch(/^GitHub-Hookshot\//)
    expect(delivered.headers.get('X-GitHub-Delivery')).toMatch(/^[0-9a-f-]{36}$/)
    expect(delivered.headers.get('X-GitHub-Hook-ID')).toBe(String(hook.id))
    expect(delivered.headers.get('X-Hub-Signature-256')).toBe(`sha256=${createHmac('sha256', 's3cret').update(delivered.body).digest('hex')}`)
    expect(delivered.headers.get('X-Hub-Signature')).toBe(`sha1=${createHmac('sha1', 's3cret').update(delivered.body).digest('hex')}`)
    expect(await verifySignature('s3cret', delivered.body, delivered.headers.get('X-Hub-Signature-256'))).toBe(true)
    const payload = JSON.parse(delivered.body)
    expect(payload).toMatchObject({
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      created: false,
      deleted: false,
      forced: false,
      commits: [{ id: 'b'.repeat(40), message: 'Fix', url: `${BASE}/alice/engine/commit/${'b'.repeat(40)}` }],
      head_commit: { id: 'b'.repeat(40) },
      pusher: { name: 'bob' },
      sender: { login: 'bob' },
      repository: { full_name: 'alice/engine', name: 'engine', private: true, default_branch: 'main', owner: { login: 'alice', type: 'User' }, clone_url: `${BASE}/alice/engine.git` },
    })
  })

  it('sends form-encoded payloads when asked to', async () => {
    await createHook({ config: { url: 'https://hooks.example.com/form', content_type: 'form' } })
    await fixture.notifications.emit(push())
    await fixture.queue.drain()
    const delivered = fixture.received[1]!
    expect(delivered.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    expect(delivered.headers.get('X-Hub-Signature-256')).toBeNull()
    expect(JSON.parse(new URLSearchParams(delivered.body).get('payload')!).ref).toBe('refs/heads/main')
  })

  it('retries failed deliveries with backoff, records each attempt and redelivers on request', async () => {
    const hook = await createHook()
    let failures = 2
    fixture.respond = () => (failures-- > 0 ? new Response('busy', { status: 503 }) : new Response('thanks', { status: 202 }))
    const start = fixture.clock.now
    await fixture.notifications.emit(push())
    await fixture.queue.drain()
    expect(fixture.received.filter((request) => request.headers.get('X-GitHub-Event') === 'push')).toHaveLength(3)
    expect(fixture.clock.now - start).toBe((30 + 120) * 1000)
    const list = (await (await fixture.api('GET', `/api/v3/repos/alice/engine/hooks/${hook.id}/deliveries`, 'alice')).json()) as {
      id: number
      guid: string
      event: string
      status: string
      status_code: number
      attempts: number
      redelivery: boolean
    }[]
    const [delivery] = list
    expect(delivery).toMatchObject({ event: 'push', status: 'OK', status_code: 202, attempts: 3, redelivery: false })
    const detail = (await (await fixture.api('GET', `/api/v3/repos/alice/engine/hooks/${hook.id}/deliveries/${delivery!.id}`, 'alice')).json()) as {
      request: { headers: Record<string, string>; payload: { ref: string } }
      response: { payload: string }
    }
    expect(detail.request.headers['X-GitHub-Event']).toBe('push')
    expect(detail.request.payload.ref).toBe('refs/heads/main')
    expect(detail.response.payload).toBe('thanks')

    fixture.respond = () => new Response('gone', { status: 410 })
    expect((await fixture.api('POST', `/api/v3/repos/alice/engine/hooks/${hook.id}/deliveries/${delivery!.id}/attempts`, 'alice')).status).toBe(202)
    await fixture.queue.drain()
    const redelivered = fixture.received[fixture.received.length - 1]!
    expect(redelivered.headers.get('X-GitHub-Delivery')).toBe(delivery!.guid)
    const after = (await (await fixture.api('GET', `/api/v3/repos/alice/engine/hooks/${hook.id}/deliveries`, 'alice')).json()) as { redelivery: boolean; status: string; attempts: number }[]
    expect(after[0]).toMatchObject({ redelivery: true, status: 'Invalid HTTP Response: 410', attempts: 1 })
  })

  it('gives up after the maximum number of attempts', async () => {
    const hook = await createHook()
    fixture.respond = () => new Response('down', { status: 500 })
    await fixture.notifications.emit(push())
    await fixture.queue.drain()
    const [delivery] = (await (await fixture.api('GET', `/api/v3/repos/alice/engine/hooks/${hook.id}/deliveries`, 'alice')).json()) as { attempts: number; state: string }[]
    expect(delivery).toMatchObject({ attempts: 5, state: 'failed' })
  })

  it('filters by event, honours inactive hooks and edits configuration', async () => {
    const hook = await createHook({ events: ['release'] })
    await fixture.notifications.emit(push())
    await fixture.queue.drain()
    expect(fixture.received).toHaveLength(1)
    const patched = await fixture.api('PATCH', `/api/v3/repos/alice/engine/hooks/${hook.id}`, 'alice', { add_events: ['push'], active: false })
    expect(await patched.json()).toMatchObject({ events: ['release', 'push'], active: false })
    await fixture.notifications.emit(push())
    await fixture.queue.drain()
    expect(fixture.received).toHaveLength(1)
    const config = await fixture.api('PATCH', `/api/v3/repos/alice/engine/hooks/${hook.id}/config`, 'alice', { url: 'https://other.example.com/', secret: '' })
    expect(await config.json()).toEqual({ url: 'https://other.example.com/', content_type: 'json', insecure_ssl: '0' })
    await fixture.api('PATCH', `/api/v3/repos/alice/engine/hooks/${hook.id}`, 'alice', { active: true })
    await fixture.notifications.emit(
      releaseEvent(contextOf(fixture, 'alice'), 'published', { id: 1, tag_name: 'v1', name: 'One', html_url: `${BASE}/r`, url: `${BASE}/api`, prerelease: false }),
    )
    await fixture.queue.drain()
    expect(fixture.received.map((request) => [request.url, request.headers.get('X-GitHub-Event')])).toEqual([
      ['https://hooks.example.com/forge', 'ping'],
      ['https://other.example.com/', 'release'],
    ])
    expect((await fixture.api('DELETE', `/api/v3/repos/alice/engine/hooks/${hook.id}`, 'alice')).status).toBe(204)
    expect((await fixture.api('GET', `/api/v3/repos/alice/engine/hooks/${hook.id}`, 'alice')).status).toBe(404)
  })

  it('delivers organization hooks for repositories of the organization', async () => {
    const org = await fixture.store.createOrganization({ login: 'guild' })
    await fixture.store.setOrganizationMember(org.id, fixture.users.carol.id, 'owner')
    await fixture.store.setOrganizationMember(org.id, fixture.users.bob.id, 'member')
    await fixture.store.createRepository({ ownerId: org.id, name: 'tools', visibility: 'public' })
    expect((await fixture.api('POST', '/api/v3/orgs/guild/hooks', 'bob', { config: { url: 'https://hooks.example.com/org' } })).status).toBe(404)
    const created = await fixture.api('POST', '/api/v3/orgs/guild/hooks', 'carol', { config: { url: 'https://hooks.example.com/org', content_type: 'json' }, events: ['*'] })
    expect(created.status).toBe(201)
    await fixture.notifications.emit(pushEvent({ baseUrl: BASE, repository: { owner: 'guild', name: 'tools' }, actor: { kind: 'user', id: fixture.users.carol.id, login: 'carol' } }, {
      ref: 'refs/tags/v1',
      before: '0'.repeat(40),
      after: 'c'.repeat(40),
      forced: false,
      commits: [],
      pusher: { name: 'carol', email: null },
    }))
    await fixture.queue.drain()
    const payload = JSON.parse(fixture.received[1]!.body)
    expect(fixture.received[1]!.headers.get('X-GitHub-Hook-Installation-Target-Type')).toBe('organization')
    expect(payload).toMatchObject({ created: true, organization: { login: 'guild' }, repository: { full_name: 'guild/tools', owner: { type: 'Organization' } } })
  })
})
