import { generateSigningKey } from '@git-forge/accounts'
import { importSecretsKey } from '@git-forge/actions'
import { createMemoryJobQueue, githubSignature, type MemoryJobQueue, readMirrorConfig, readRefs, utf8 } from '@git-forge/core'
import { basicAuth, httpBackendHandler } from '@git-forge/core/test/mirror-helpers.ts'
import { commitAll, initRepo, sampleHistory, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AppJob } from '../../src/app.ts'
import { git } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://backup.example'
const TOKEN = 'ghp_backup_token'

type Hook = { repository: string; url: string; secret: string; authorization: string | null }

const githubRepo = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  full_name: `levino/${name}`,
  clone_url: `https://github.com/levino/${name}.git`,
  private: false,
  fork: false,
  archived: false,
  default_branch: 'main',
  owner: { login: 'levino' },
  ...extra,
})

describe('GitHub backup mirrors', () => {
  let forge: NodeForge
  let jobs: MemoryJobQueue<AppJob>
  let admin: string
  let root: string
  let work: string
  const hooks: Hook[] = []
  const apiCalls: { path: string; authorization: string | null }[] = []
  const logged: string[] = []

  const api = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    apiCalls.push({ path: url.pathname, authorization: request.headers.get('Authorization') })
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.pathname === '/user') return reply({ login: 'levino' })
    if (url.pathname === '/user/repos') {
      return reply([githubRepo('private-one', { private: true }), githubRepo('public-one'), githubRepo('forked', { fork: true }), githubRepo('taken'), githubRepo('.github')])
    }
    const hook = /^\/repos\/levino\/([^/]+)\/hooks$/.exec(url.pathname)
    if (hook && request.method === 'GET') return reply([])
    if (hook && request.method === 'POST') {
      const body = (await request.json()) as { config: { url: string; secret: string } }
      hooks.push({ repository: hook[1]!, url: body.config.url, secret: body.config.secret, authorization: request.headers.get('Authorization') })
      return reply({ id: hooks.length, config: {} }, 201)
    }
    return reply({ message: 'Not Found' }, 404)
  }

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.hostname === 'api.github.com') return api(request)
    if (url.hostname !== 'github.com') return new Response('unexpected host', { status: 502 })
    if (url.pathname.startsWith('/levino/private-one.git') && request.headers.get('Authorization') !== basicAuth('x-access-token', TOKEN)) {
      return new Response('authentication required\n', { status: 401 })
    }
    return (await httpBackendHandler(root)(request)) ?? new Response('not found', { status: 404 })
  }

  const head = async (name: string) => (await readRefs(forge.storage, { owner: 'admin', name }))?.state.refs['refs/upstream/origin/heads/main']

  beforeAll(async () => {
    work = initRepo()
    sampleHistory(work, 3)
    root = tempDir('git-forge-github-')
    for (const name of ['private-one', 'public-one']) {
      await git(root, ['clone', '-q', '--bare', work, `levino/${name}.git`])
      await git(`${root}/levino/${name}.git`, ['config', 'uploadpack.allowFilter', 'true'])
    }
    const original = console.log
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
      original(...args)
    }
    jobs = createMemoryJobQueue<AppJob>((job) => forge.runJob(job), { delayMs: () => 0, maxAttempts: 2 })
    forge = await nodeForge({
      publicUrl: BASE,
      instanceKey: (await generateSigningKey()).key,
      jobs,
      fetch,
      secretsKey: await importSecretsKey('11'.repeat(32)),
    })
    admin = await bootstrap(forge, BASE)
    await call(forge, BASE, 'POST', '/api/repos', admin, { owner: 'admin', name: 'taken' })
  })

  it('mirrors all repositories of a GitHub account, private ones with a stored token, and registers webhooks', async () => {
    const response = await call(forge, BASE, 'POST', '/api/mirrors/github', admin, { account: 'levino', owner: 'admin', token: TOKEN, webhook: true })
    expect(response.status).toBe(202)
    const body = (await response.json()) as { queued: { github: string; repository: string }[]; skipped: { github: string; reason: string }[] }
    expect(body.queued.map((entry) => entry.repository)).toEqual(['admin/private-one', 'admin/public-one'])
    expect(body.skipped).toEqual([
      { github: 'levino/taken', repository: 'admin/taken', reason: 'exists' },
      { github: 'levino/.github', repository: 'admin/.github', reason: 'invalid name' },
    ])
    await jobs.idle()
    expect(jobs.failed).toEqual([])
    const main = (await git(work, ['rev-parse', 'main'])).trim()
    expect(await head('private-one')).toBe(main)
    expect(await head('public-one')).toBe(main)
    expect(await readMirrorConfig(forge.storage, { owner: 'admin', name: 'private-one' })).toMatchObject({ url: 'https://github.com/levino/private-one.git', auth: 'token' })
    expect((await readMirrorConfig(forge.storage, { owner: 'admin', name: 'public-one' }))?.auth).toBeUndefined()
    expect(hooks.map((hook) => [hook.repository, hook.url])).toEqual([
      ['private-one', `${BASE}/api/repos/admin/private-one/mirrors/origin/webhook`],
      ['public-one', `${BASE}/api/repos/admin/public-one/mirrors/origin/webhook`],
    ])
    expect(hooks.every((hook) => hook.authorization === `Bearer ${TOKEN}` && /^[0-9a-f]{64}$/.test(hook.secret))).toBe(true)
    const visibility = await call(forge, BASE, 'GET', '/api/repos/admin/private-one/mirrors', admin)
    expect(await visibility.text()).not.toContain(TOKEN)
    expect(logged.some((line) => line.includes(TOKEN))).toBe(false)
    expect(JSON.stringify(jobs.completed)).not.toContain(TOKEN)

    const again = (await (await call(forge, BASE, 'POST', '/api/mirrors/github', admin, { account: 'levino', owner: 'admin', token: TOKEN })).json()) as typeof body
    expect(again.queued).toEqual([])
    expect(again.skipped.filter((entry) => entry.reason === 'exists')).toHaveLength(3)
  })

  it('validates bulk requests and keeps private repositories out without a token', async () => {
    expect((await call(forge, BASE, 'POST', '/api/mirrors/github', undefined, { account: 'levino', owner: 'admin' })).status).toBe(401)
    expect((await call(forge, BASE, 'POST', '/api/mirrors/github', admin, { account: 'levino', owner: 'admin', webhook: true })).status).toBe(400)
    expect((await call(forge, BASE, 'POST', '/api/mirrors/github', admin, { account: 'levino', owner: 'nobody' })).status).toBe(404)
  })

  it('syncs on a signed GitHub push webhook and rejects bad signatures', async () => {
    const hook = hooks.find((entry) => entry.repository === 'private-one')!
    const path = '/api/repos/admin/private-one/mirrors/origin/webhook'
    const deliver = async (event: string, body: Uint8Array, signature: string) =>
      forge.fetch(new Request(`${BASE}${path}`, { method: 'POST', headers: { 'X-GitHub-Event': event, 'X-Hub-Signature-256': signature, 'Content-Type': 'application/json' }, body: body as Uint8Array<ArrayBuffer> }))
    const ping = utf8('{"zen":"Keep it logically awesome."}')
    expect((await deliver('ping', ping, await githubSignature(hook.secret, ping))).status).toBe(200)
    writeFile(work, 'later.txt', 'later\n')
    commitAll(work, 'later')
    await git(work, ['push', '-q', `${root}/levino/private-one.git`, 'main'])
    const payload = utf8('{"ref":"refs/heads/main"}')
    expect((await deliver('push', payload, await githubSignature('wrong', payload))).status).toBe(401)
    expect((await deliver('push', payload, 'sha256=00')).status).toBe(401)
    expect(await head('private-one')).not.toBe((await git(work, ['rev-parse', 'main'])).trim())
    const accepted = await deliver('push', payload, await githubSignature(hook.secret, payload))
    expect(accepted.status).toBe(202)
    await jobs.idle()
    expect(await head('private-one')).toBe((await git(work, ['rev-parse', 'main'])).trim())
    const unknown = await forge.fetch(new Request(`${BASE}/api/repos/admin/taken/mirrors/origin/webhook`, { method: 'POST', body: payload as Uint8Array<ArrayBuffer> }))
    expect(unknown.status).toBe(404)
  })

  it('sets up a webhook secret for an existing mirror for manual registration', async () => {
    const path = '/api/repos/admin/public-one/mirrors/origin/webhook'
    expect((await call(forge, BASE, 'PUT', path)).status).toBe(401)
    const setup = await call(forge, BASE, 'PUT', path, admin, {})
    expect(setup.status).toBe(200)
    const body = (await setup.json()) as { url: string; secret: string; contentType: string; events: string[]; hook?: unknown }
    expect(body).toMatchObject({ url: `${BASE}${path}`, contentType: 'json', events: ['push'] })
    expect(body.hook).toBeUndefined()
    const payload = utf8('{}')
    const old = hooks.find((entry) => entry.repository === 'public-one')!.secret
    const deliver = (secret: string) =>
      githubSignature(secret, payload).then((signature) =>
        forge.fetch(new Request(`${BASE}${path}`, { method: 'POST', headers: { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': signature }, body: payload as Uint8Array<ArrayBuffer> })),
      )
    expect((await deliver(old)).status).toBe(401)
    expect((await deliver(body.secret)).status).toBe(202)
    await jobs.idle()
  })

  it('stores a token given with a single mirror and never returns it', async () => {
    await call(forge, BASE, 'POST', '/api/repos', admin, { owner: 'admin', name: 'single' })
    const bad = await call(forge, BASE, 'POST', '/api/repos/admin/single/mirrors', admin, { url: 'https://github.com/levino/private-one.git', token: TOKEN })
    expect(bad.status).toBe(400)
    const added = await call(forge, BASE, 'POST', '/api/repos/admin/single/mirrors', admin, { url: 'https://github.com/levino/private-one.git', auth: 'token', token: TOKEN })
    expect(added.status).toBe(201)
    expect(await added.text()).not.toContain(TOKEN)
    await jobs.idle()
    expect(jobs.failed).toEqual([])
    expect(await head('single')).toBe((await git(work, ['rev-parse', 'main'])).trim())
  })
})
