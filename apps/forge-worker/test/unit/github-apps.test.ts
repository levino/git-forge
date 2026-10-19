import { base64UrlEncode, sql, type UserPrincipal } from '@git-forge/accounts'
import { importSecretsKey } from '@git-forge/actions'
import { verifySignature } from '@git-forge/notifications'
import { commitAll, initRepo, sampleHistory, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitFails } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

type Hook = { path: string; event: string | null; signature: string | null; target: string | null; raw: string; body: Record<string, unknown> }

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T

const sign = async (pem: string, iss: string, offset = 0): Promise<string> => {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (char) => char.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const part = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
  const now = Math.floor(Date.now() / 1000) + offset
  const input = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss })}`
  return `${input}.${base64UrlEncode(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input))))}`
}

describe('webhook tests, sealed secrets and GitHub Apps', () => {
  let server: RunningServer
  let forge: NodeForge
  let admin: string
  let user: UserPrincipal
  const received: Hook[] = []

  beforeAll(async () => {
    let handler = (_request: Request) => Promise.resolve(new Response('starting', { status: 503 }))
    server = await startServer((request) => handler(request))
    forge = await nodeForge({
      publicUrl: server.url,
      secretsKey: await importSecretsKey('22'.repeat(32)),
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.host !== 'hooks.example.com') return globalThis.fetch(request)
        const raw = await request.text()
        received.push({
          path: url.pathname,
          event: request.headers.get('X-GitHub-Event'),
          signature: request.headers.get('X-Hub-Signature-256'),
          target: request.headers.get('X-GitHub-Hook-Installation-Target-Type'),
          raw,
          body: JSON.parse(raw) as Record<string, unknown>,
        })
        return new Response('ok')
      },
    })
    handler = forge.fetch
    admin = await bootstrap(forge, server.url, 'admin')
    await call(forge, server.url, 'POST', '/api/repos', admin, { owner: 'admin', name: 'engine' })
    await call(forge, server.url, 'POST', '/api/repos', admin, { owner: 'admin', name: 'other' })
    const account = (await forge.services.store.findAccount('admin'))!
    user = { kind: 'user', id: account.id, login: 'admin', limits: null, tokenId: null }
  })

  afterAll(async () => {
    await server.close()
  })

  it('seals new hook secrets, keeps plaintext rows working and sends the latest push on tests', async () => {
    const created = await json<{ id: number; config: { secret: string } }>(
      await call(forge, server.url, 'POST', '/api/v3/repos/admin/engine/hooks', admin, { config: { url: 'https://hooks.example.com/repo', content_type: 'json', secret: 's3cret' }, events: ['push'] }),
    )
    expect(created.config.secret).toBe('********')
    const [row] = await forge.db.all<{ secret: string; secret_key_id: string | null }>(sql('SELECT secret, secret_key_id FROM webhooks WHERE id = ?', created.id))
    expect(row!.secret_key_id).not.toBeNull()
    expect(row!.secret).not.toContain('s3cret')
    const ping = received.find((hook) => hook.event === 'ping')!
    expect(await verifySignature('s3cret', ping.raw, ping.signature)).toBe(true)

    expect((await call(forge, server.url, 'POST', `/api/v3/repos/admin/engine/hooks/${created.id}/tests`, admin)).status).toBe(204)
    expect(received.filter((hook) => hook.event === 'push')).toHaveLength(0)
    const source = initRepo()
    sampleHistory(source, 2)
    await git(source, ['-c', `http.extraHeader=Authorization: Bearer ${admin}`, 'push', '-q', `${server.url}/admin/engine.git`, 'main'])
    expect(received.filter((hook) => hook.event === 'push')).toHaveLength(1)

    await forge.db.run(sql("UPDATE webhooks SET secret = 'legacy', secret_key_id = NULL, secret_iv = NULL WHERE id = ?", created.id))
    expect((await call(forge, server.url, 'POST', `/api/v3/repos/admin/engine/hooks/${created.id}/tests`, admin)).status).toBe(204)
    const pushes = received.filter((hook) => hook.event === 'push')
    expect(pushes).toHaveLength(2)
    expect(pushes[1]!.body).toMatchObject({ ref: 'refs/heads/main', repository: { full_name: 'admin/engine' } })
    expect(await verifySignature('legacy', pushes[1]!.raw, pushes[1]!.signature)).toBe(true)
    const deliveries = await json<{ event: string }[]>(await call(forge, server.url, 'GET', `/api/v3/repos/admin/engine/hooks/${created.id}/deliveries`, admin))
    expect(deliveries.map((delivery) => delivery.event)).toEqual(['push', 'push', 'ping'])
  })

  it('registers an app, installs it and enforces installation tokens', async () => {
    const apps = forge.services.githubApps
    const app = await apps.createApp(user, 'admin', {
      name: 'CI Bot',
      permissions: { issues: 'write', contents: 'read' },
      events: ['issues'],
      webhookUrl: 'https://hooks.example.com/app',
      webhookSecret: 'appsecret',
    })
    const key = await apps.generateKey(user, app.slug)
    expect(key.pem).toMatch(/^-----BEGIN PRIVATE KEY-----/)
    const jwt = await sign(key.pem, app.id)

    expect((await call(forge, server.url, 'GET', '/api/v3/app', 'garbage.jwt.value')).status).toBe(401)
    expect((await call(forge, server.url, 'GET', '/api/v3/app', await sign(key.pem, app.id, -3600))).status).toBe(401)
    const self = await json<{ slug: string; permissions: Record<string, string> }>(await call(forge, server.url, 'GET', '/api/v3/app', jwt))
    expect(self).toMatchObject({ slug: 'ci-bot', permissions: { issues: 'write', contents: 'read', metadata: 'read' } })
    expect((await call(forge, server.url, 'GET', '/api/app', await sign(key.pem, app.client_id!))).status).toBe(200)

    const engine = (await forge.services.store.findRepository('admin', 'engine'))!
    const { installation } = await apps.install(user, app.slug, 'admin', 'selected', [engine.id], server.url)
    const installed = received.find((hook) => hook.path === '/app' && hook.event === 'installation')!
    expect(installed.target).toBe('integration')
    expect(installed.body).toMatchObject({ action: 'created', installation: { id: installation.id, repository_selection: 'selected' }, repositories: [{ full_name: 'admin/engine' }] })
    expect(await verifySignature('appsecret', installed.raw, installed.signature)).toBe(true)
    expect((await json<{ id: number }[]>(await call(forge, server.url, 'GET', '/api/v3/app/installations', jwt))).map((entry) => entry.id)).toEqual([installation.id])
    expect((await call(forge, server.url, 'GET', '/api/v3/repos/admin/engine/installation', jwt)).status).toBe(200)
    expect((await call(forge, server.url, 'GET', '/api/v3/repos/admin/other/installation', jwt)).status).toBe(404)

    expect((await call(forge, server.url, 'POST', `/api/v3/app/installations/${installation.id}/access_tokens`, jwt, { permissions: { administration: 'write' } })).status).toBe(422)
    const issued = await call(forge, server.url, 'POST', `/api/v3/app/installations/${installation.id}/access_tokens`, jwt, {})
    expect(issued.status).toBe(201)
    const { token, permissions } = await json<{ token: string; permissions: Record<string, string> }>(issued)
    expect(permissions).toMatchObject({ issues: 'write' })
    const listed = await json<{ total_count: number; repositories: { full_name: string }[] }>(await call(forge, server.url, 'GET', '/api/v3/installation/repositories', token))
    expect(listed.repositories.map((repo) => repo.full_name)).toEqual(['admin/engine'])
    expect((await call(forge, server.url, 'POST', '/api/v3/repos/admin/engine/issues', token, { title: 'From the bot' })).status).toBe(201)
    expect((await call(forge, server.url, 'POST', '/api/v3/repos/admin/other/issues', token, { title: 'Nope' })).status).toBe(404)
    expect((await call(forge, server.url, 'DELETE', '/api/v3/repos/admin/engine', token)).status).toBeGreaterThanOrEqual(403)
    const remote = server.url.replace('://', `://x-access-token:${token}@`)
    const clone = initRepo()
    expect(await git(clone, ['ls-remote', `${remote}/admin/engine.git`])).toContain('refs/heads/main')
    await git(clone, ['fetch', '-q', `${remote}/admin/engine.git`, 'main'])
    await git(clone, ['checkout', '-q', '-B', 'main', 'FETCH_HEAD'])
    writeFile(clone, 'bot.txt', 'from the bot\n')
    commitAll(clone, 'Bot change')
    expect(await gitFails(clone, ['push', '-q', `${remote}/admin/engine.git`, 'main'])).toContain('contents: write')
    expect((await call(forge, server.url, 'PUT', '/api/v3/repos/admin/engine/contents/bot.txt', token, { message: 'x', content: btoa('x') })).status).toBe(403)
    expect((await call(forge, server.url, 'PUT', '/api/v3/repos/admin/engine/hooks', token, {})).status).toBe(403)
    expect((await call(forge, server.url, 'GET', '/api/v3/repos/admin/engine/subscription', token)).status).toBe(403)
    expect((await call(forge, server.url, 'GET', '/api/v3/repos/admin/engine/pulls', token)).status).toBe(403)
    const issueHook = received.find((hook) => hook.path === '/app' && hook.event === 'issues')!
    expect(issueHook.body).toMatchObject({ action: 'opened', installation: { id: installation.id }, repository: { full_name: 'admin/engine' } })

    const other = (await forge.services.store.findRepository('admin', 'other'))!
    await apps.updateInstallation(user, installation.id, 'selected', [engine.id, other.id], server.url)
    expect(received.find((hook) => hook.event === 'installation_repositories')!.body).toMatchObject({ action: 'added', repositories_added: [{ full_name: 'admin/other' }] })

    await apps.uninstall(user, installation.id, server.url)
    expect((await call(forge, server.url, 'GET', '/api/v3/installation/repositories', token)).status).toBe(401)
    expect(received.filter((hook) => hook.event === 'installation').map((hook) => hook.body.action)).toEqual(['created', 'deleted'])
  })

  it('lets contents:write push, but not workflow changes without workflows:write', async () => {
    const apps = forge.services.githubApps
    const app = await apps.createApp(user, 'admin', { name: 'Pusher', permissions: { contents: 'write' } })
    const key = await apps.generateKey(user, app.slug)
    const { installation } = await apps.install(user, app.slug, 'admin', 'all', [], server.url)
    const issued = await call(forge, server.url, 'POST', `/api/v3/app/installations/${installation.id}/access_tokens`, await sign(key.pem, app.id), {})
    const { token } = await json<{ token: string }>(issued)
    const remote = `${server.url.replace('://', `://x-access-token:${token}@`)}/admin/engine.git`
    const clone = initRepo()
    await git(clone, ['fetch', '-q', remote, 'main'])
    await git(clone, ['checkout', '-q', '-B', 'main', 'FETCH_HEAD'])
    writeFile(clone, 'notes.txt', 'pushed by an app\n')
    commitAll(clone, 'App change')
    await git(clone, ['push', '-q', remote, 'main'])
    writeFile(clone, '.github/workflows/ci.yml', 'on: push\n')
    commitAll(clone, 'Add a workflow')
    expect(await gitFails(clone, ['push', '-q', remote, 'main'])).toContain('workflows permission')
    expect(await gitFails(clone, ['push', '-q', remote, 'main:refs/heads/sneaky'])).toContain('workflows permission')
    expect((await call(forge, server.url, 'POST', '/api/v3/repos/admin/engine/issues', token, { title: 'No issues permission' })).status).toBe(403)
  })

  it('requires workflows:write for workflow changes made through the API', async () => {
    const apps = forge.services.githubApps
    const tokenFor = async (name: string, permissions: Record<string, 'read' | 'write'>): Promise<string> => {
      const app = await apps.createApp(user, 'admin', { name, permissions })
      const key = await apps.generateKey(user, app.slug)
      const { installation } = await apps.install(user, app.slug, 'admin', 'all', [], server.url)
      return (await json<{ token: string }>(await call(forge, server.url, 'POST', `/api/v3/app/installations/${installation.id}/access_tokens`, await sign(key.pem, app.id), {}))).token
    }
    const writer = await tokenFor('Writer', { contents: 'write', pull_requests: 'write' })
    const maintainer = await tokenFor('Maintainer', { contents: 'write', workflows: 'write' })
    const put = (token: string, path: string, branch = 'main') => call(forge, server.url, 'PUT', `/api/v3/repos/admin/engine/contents/${path}`, token, { message: path, content: btoa('on: push\n'), branch })

    const refused = await put(writer, '.github/workflows/api.yml')
    expect(refused.status).toBe(403)
    expect(await json<{ message: string }>(refused)).toMatchObject({ message: expect.stringContaining('workflows permission') })
    expect((await put(writer, 'docs/api.yml')).status).toBe(201)
    expect((await put(maintainer, '.github/workflows/api.yml')).status).toBe(201)

    const remote = `${server.url.replace('://', `://x-access-token:${maintainer}@`)}/admin/engine.git`
    const clone = initRepo()
    await git(clone, ['fetch', '-q', remote, 'main'])
    await git(clone, ['checkout', '-q', '-B', 'main', 'FETCH_HEAD'])
    writeFile(clone, '.github/workflows/release.yml', 'on: push\n')
    commitAll(clone, 'Add a release workflow')
    await git(clone, ['push', '-q', remote, 'main:refs/heads/workflow-change'])
    const pull = await json<{ number: number }>(await call(forge, server.url, 'POST', '/api/v3/repos/admin/engine/pulls', admin, { title: 'Workflow', head: 'workflow-change', base: 'main' }))
    const merge = await call(forge, server.url, 'PUT', `/api/v3/repos/admin/engine/pulls/${pull.number}/merge`, writer, {})
    expect(merge.status).toBe(403)
    expect((await call(forge, server.url, 'POST', '/api/v3/repos/admin/engine/releases', writer, { tag_name: 'v-workflow', target_commitish: 'workflow-change' })).status).toBe(403)
  })

  it('converts a manifest code once into credentials', async () => {
    const { app, code } = await forge.services.githubApps.createFromManifest(user, 'admin', {
      name: 'Manifest App',
      url: 'https://example.com',
      hook_attributes: { url: 'https://hooks.example.com/manifest' },
      redirect_url: 'https://example.com/done',
      default_permissions: { checks: 'write' },
      default_events: ['check_run'],
    })
    const converted = await call(forge, server.url, 'POST', `/api/app-manifests/${code}/conversions`)
    expect(converted.status).toBe(201)
    const body = await json<{ id: string; pem: string; webhook_secret: string; client_secret: string; permissions: Record<string, string> }>(converted)
    expect(body).toMatchObject({ id: app.id, permissions: { checks: 'write', metadata: 'read' } })
    expect(body.webhook_secret).toBeTruthy()
    expect((await call(forge, server.url, 'GET', '/api/v3/app', await sign(body.pem, app.id))).status).toBe(200)
    expect((await call(forge, server.url, 'POST', `/api/v3/app-manifests/${code}/conversions`)).status).toBe(404)
  })

  it('emits deleted comments, milestones and edited reviews', async () => {
    await call(forge, server.url, 'POST', '/api/v3/repos/admin/other/hooks', admin, { config: { url: 'https://hooks.example.com/all', content_type: 'json' }, events: ['*'] })
    await call(forge, server.url, 'POST', '/api/v3/repos/admin/other/issues', admin, { title: 'Track' })
    await call(forge, server.url, 'POST', '/api/v3/repos/admin/other/milestones', admin, { title: 'v1' })
    await call(forge, server.url, 'PATCH', '/api/v3/repos/admin/other/issues/1', admin, { milestone: 1 })
    const comment = await json<{ id: number }>(await call(forge, server.url, 'POST', '/api/v3/repos/admin/other/issues/1/comments', admin, { body: 'gone soon' }))
    expect((await call(forge, server.url, 'DELETE', `/api/v3/repos/admin/other/issues/comments/${comment.id}`, admin)).status).toBe(204)
    const events = received.filter((hook) => hook.path === '/all' && hook.event !== 'ping').map((hook) => `${hook.event}.${String(hook.body.action)}`)
    expect(events).toEqual(['issues.opened', 'issues.milestoned', 'issue_comment.created', 'issue_comment.deleted'])
    const deleted = received.filter((hook) => hook.path === '/all').at(-1)!
    expect(deleted.body).toMatchObject({ comment: { id: comment.id, body: 'gone soon' }, issue: { number: 1, milestone: { title: 'v1' } } })
  })
})
