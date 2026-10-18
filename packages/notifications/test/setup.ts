import { type AccountsStore, applyMigrations, createAccountsStore, type Database, MIGRATIONS } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { createMemoryEmailSender, createRepository, type JobQueue, MemoryStorage, type MemoryEmailSender } from '@git-forge/core'
import { createNotifications, type NotificationJob, type Notifications } from '../src/hub.ts'
import { handleNotificationsRequest } from '../src/http.ts'

export const BASE = 'https://forge.example.org'

export type Clock = { now: number }

export type TestQueue = JobQueue<NotificationJob> & {
  readonly pending: { job: NotificationJob; at: number }[]
  drain(): Promise<void>
}

export const createTestQueue = (clock: Clock, run: () => (job: NotificationJob) => Promise<void>): TestQueue => {
  const pending: { job: NotificationJob; at: number }[] = []
  return {
    pending,
    enqueue: async (job, options = {}) => {
      pending.push({ job, at: clock.now + (options.delaySeconds ?? 0) * 1000 })
    },
    drain: async () => {
      for (let steps = 0; pending.length > 0; steps++) {
        if (steps > 1000) throw new Error('queue does not settle')
        pending.sort((a, b) => a.at - b.at)
        const next = pending.shift()!
        if (next.at > clock.now) clock.now = next.at
        await run()(next.job)
      }
    },
  }
}

export type Recorded = { url: string; headers: Headers; body: string }

export type Fixture = {
  readonly db: Database
  readonly store: AccountsStore
  readonly storage: MemoryStorage
  readonly clock: Clock
  readonly queue: TestQueue
  readonly email: MemoryEmailSender
  readonly notifications: Notifications
  readonly received: Recorded[]
  respond: (request: Recorded) => Response | Promise<Response>
  readonly users: Record<'alice' | 'bob' | 'carol' | 'dave', { id: string; token: string }>
  readonly api: (method: string, path: string, user: keyof Fixture['users'] | null, body?: unknown) => Promise<Response>
}

export const setup = async (): Promise<Fixture> => {
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const clock: Clock = { now: Date.parse('2026-10-18T10:00:00Z') }
  const store = createAccountsStore(db, { now: () => clock.now })
  const storage = new MemoryStorage()
  const email = createMemoryEmailSender('forge@forge.example.org')
  const received: Recorded[] = []
  const fixture = {} as { -readonly [K in keyof Fixture]: Fixture[K] }
  fixture.respond = () => new Response('ok')
  let notifications: Notifications | undefined
  const queue = createTestQueue(clock, () => notifications!.runJob)
  notifications = createNotifications({
    db,
    directory: store,
    storage,
    jobs: queue,
    email,
    fetch: async (request) => {
      const recorded = { url: request.url, headers: request.headers, body: await request.text() }
      received.push(recorded)
      return fixture.respond(recorded)
    },
    allowInsecureWebhooks: false,
    baseUrl: BASE,
    now: () => clock.now,
    log: () => {},
  })
  const users = {} as Fixture['users']
  for (const login of ['alice', 'bob', 'carol', 'dave'] as const) {
    const { id } = await store.createUser({ login, email: `${login}@example.org` })
    const { token } = await store.createPersonalAccessToken(id, { name: 'test', scopes: ['repo:admin'], expiresAt: null })
    users[login] = { id, token }
  }
  const repository = await store.createRepository({ ownerId: users.alice.id, name: 'engine', visibility: 'private' })
  await store.setCollaborator(repository.id, users.bob.id, 'write')
  await store.setCollaborator(repository.id, users.dave.id, 'read')
  await createRepository(storage, { owner: 'alice', name: 'engine' })
  const api = async (method: string, path: string, user: keyof Fixture['users'] | null, body?: unknown) => {
    const request = new Request(`${BASE}${path}`, {
      method,
      headers: { ...(user ? { Authorization: `token ${users[user].token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const response = await handleNotificationsRequest(request, {
      notifications: notifications!,
      directory: store,
      authenticate: async (incoming) => {
        const header = incoming.headers.get('Authorization')
        if (!header) return { kind: 'anonymous' }
        return store.authenticateToken(header.replace(/^token\s+/i, ''))
      },
      isInstanceAdmin: store.isInstanceAdmin,
      baseUrl: () => BASE,
    })
    if (!response) throw new Error(`no route for ${method} ${path}`)
    return response
  }
  Object.assign(fixture, { db, store, storage, clock, queue, email, notifications, received, users, api })
  return fixture as Fixture
}
