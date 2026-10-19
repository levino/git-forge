import { commitAll, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateEs256Key, importEs256Key, issueToken } from '@git-forge/actions'
import { git } from '../e2e/history.ts'
import { isForgePath } from '../../src/routing.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T

describe('CI with collaboration', () => {
  let server: RunningServer
  let forge: NodeForge
  let admin: string

  beforeAll(async () => {
    let handler = (_request: Request) => Promise.resolve(new Response('starting', { status: 503 }))
    server = await startServer((request) => handler(request))
    forge = await nodeForge({ publicUrl: server.url, actions: { instanceId: '00000000-0000-0000-0000-000000000000', idTokenKeys: [await importEs256Key(await generateEs256Key())] } })
    handler = forge.fetch
    admin = await bootstrap(forge, server.url, 'admin')
    expect((await call(forge, server.url, 'POST', '/api/repos', admin, { owner: 'admin', name: 'ci' })).status).toBe(201)
  })

  afterAll(async () => {
    await server.close()
  })

  it('runs pull_request workflows for pull requests and writes check runs through the collaboration store', async () => {
    const source = initRepo()
    writeFile(source, '.github/workflows/pr.yml', 'on:\n  pull_request:\n    branches: [main]\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo "${{ github.head_ref }}"\n')
    commitAll(source, 'workflow')
    await git(source, ['checkout', '-q', '-b', 'feature'])
    writeFile(source, 'README.md', 'feature\n')
    const head = commitAll(source, 'feature')
    await git(source, ['-c', `http.extraHeader=Authorization: Bearer ${admin}`, 'push', '-q', `${server.url}/admin/ci.git`, 'main', 'feature'])
    const before = await json<{ workflow_runs: unknown[] }>(await call(forge, server.url, 'GET', '/api/v3/repos/admin/ci/actions/runs', admin))
    expect(before.workflow_runs).toHaveLength(0)
    const opened = await call(forge, server.url, 'POST', '/api/v3/repos/admin/ci/pulls', admin, { title: 'Feature', head: 'feature', base: 'main' })
    expect(opened.status, await opened.clone().text()).toBe(201)
    const runs = await json<{ workflow_runs: { event: string; head_sha: string; head_branch: string }[] }>(await call(forge, server.url, 'GET', '/api/v3/repos/admin/ci/actions/runs', admin))
    expect(runs.workflow_runs).toEqual([expect.objectContaining({ event: 'pull_request', head_sha: head, head_branch: 'refs/pull/1/head' })])
    const checks = await json<{ check_runs: { name: string; status: string; head_sha: string }[] }>(await call(forge, server.url, 'GET', `/api/v3/repos/admin/ci/commits/${head}/check-runs`, admin))
    expect(checks.check_runs.map((check) => [check.name, check.status, check.head_sha])).toEqual([['test', 'queued', head]])
  })

  it('runs pull_request workflows for pull requests from forks without the base repository having the branch', async () => {
    expect((await call(forge, server.url, 'POST', '/api/admin/users', admin, { login: 'contrib' })).status).toBe(201)
    const contrib = (await json<{ token: string }>(await call(forge, server.url, 'POST', '/api/admin/users/contrib/tokens', admin, { scopes: ['repo:write'] }))).token
    expect((await call(forge, server.url, 'PUT', '/api/repos/admin/ci/collaborators/contrib', admin, { role: 'read' })).status).toBe(200)
    const fork = await call(forge, server.url, 'POST', '/api/v3/repos/admin/ci/forks', contrib, {})
    expect(fork.status, await fork.clone().text()).toBe(202)
    const source = initRepo()
    await git(source, ['-c', `http.extraHeader=Authorization: Bearer ${contrib}`, 'fetch', '-q', `${server.url}/contrib/ci.git`, 'main:refs/remotes/fork/main'])
    await git(source, ['checkout', '-q', '-b', 'from-fork', 'fork/main'])
    writeFile(source, 'FORK.md', 'fork\n')
    const head = commitAll(source, 'from the fork')
    await git(source, ['-c', `http.extraHeader=Authorization: Bearer ${contrib}`, 'push', '-q', `${server.url}/contrib/ci.git`, 'from-fork'])
    const opened = await call(forge, server.url, 'POST', '/api/v3/repos/admin/ci/pulls', contrib, { title: 'From the fork', head: 'contrib:from-fork', base: 'main' })
    expect(opened.status, await opened.clone().text()).toBe(201)
    const runs = await json<{ workflow_runs: { event: string; head_sha: string; head_branch: string }[] }>(await call(forge, server.url, 'GET', '/api/v3/repos/admin/ci/actions/runs', admin))
    expect(runs.workflow_runs).toContainEqual(expect.objectContaining({ event: 'pull_request', head_sha: head, head_branch: 'refs/pull/2/head' }))
  })

  it('lets jobs use private actions of the same owner only from trusted runs after the action repository opted in', async () => {
    const push = async (name: string, files: Record<string, string>) => {
      expect((await call(forge, server.url, 'POST', '/api/repos', admin, { owner: 'admin', name })).status).toBe(201)
      const source = initRepo()
      for (const [path, content] of Object.entries(files)) writeFile(source, path, content)
      const sha = commitAll(source, name)
      await git(source, ['-c', `http.extraHeader=Authorization: Bearer ${admin}`, 'push', '-q', `${server.url}/admin/${name}.git`, 'main'])
      return sha
    }
    const actionSha = await push('tool', { 'action.yml': 'name: tool\nruns:\n  using: node20\n  main: index.js\n' })
    await push('app', { '.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    runs-on: self-hosted\n    steps:\n      - uses: admin/tool@main\n' })
    const job = (await forge.db.all<{ id: string; plan_id: string }>({ sql: "SELECT j.id, j.plan_id FROM actions_jobs j JOIN actions_runs r ON r.id = j.run_id WHERE r.repo = 'app'", params: [] }))[0]!
    const runtime = await issueToken(forge.db, { kind: 'runtime', jobId: job.id, owner: 'admin', repo: 'app', ttlMs: 60_000 }, Date.now())
    const info = () =>
      forge.fetch(
        new Request(`${server.url}/_services/actions/_apis/v1/ActionDownloadInfo/s/actions/${job.plan_id}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${runtime}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ actions: [{ nameWithOwner: 'admin/tool', ref: 'main' }] }),
        }),
      )
    expect((await info()).status).toBe(404)
    expect((await call(forge, server.url, 'PUT', '/api/v3/repos/admin/tool/actions/permissions/access', admin, { access_level: 'user' })).status).toBe(204)
    const resolved = await info()
    expect(resolved.status).toBe(200)
    const { tarballUrl, authentication } = (await json<{ actions: Record<string, { tarballUrl: string; authentication: { token: string } }> }>(resolved)).actions['admin/tool@main']!
    const basic = { Authorization: `Basic ${btoa(`x-access-token:${authentication.token}`)}` }
    expect((await forge.fetch(new Request(tarballUrl, { headers: basic }))).status).toBe(200)
    expect((await forge.fetch(new Request(`${server.url}/api/v3/repos/admin/tool/zipball/${actionSha}`, { headers: basic }))).status).toBe(200)
    for (const path of ['/api/v3/repos/admin/tool/tarball/main', '/admin/tool/archive/main.tar.gz', '/admin/tool.git/info/refs?service=git-upload-pack', '/api/v3/repos/admin/tool/actions/runs', '/api/v3/repos/admin/app/tarball/main']) {
      expect((await forge.fetch(new Request(`${server.url}${path}`, { headers: basic }))).status, path).toBeGreaterThanOrEqual(400)
    }
    await expect(git(initRepo(), ['clone', '-q', `${server.url.replace('://', `://x-access-token:${authentication.token}@`)}/admin/tool.git`, 'clone'])).rejects.toThrow()
    await forge.db.run({ sql: "UPDATE actions_runs SET trusted = 0 WHERE repo = 'app'", params: [] })
    expect((await info()).status).toBe(404)
  })

  it('mounts the results service: twirp, cache, blob URLs and the ID token issuer', async () => {
    expect(['/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry', '/_services/cache/_apis/artifactcache/cache', '/_services/token/idtoken'].every(isForgePath)).toBe(true)
    const twirp = await forge.fetch(
      new Request(`${server.url}/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    )
    expect(twirp.status).toBe(401)
    expect(await twirp.json()).toMatchObject({ code: 'unauthenticated' })
    expect((await forge.fetch(new Request(`${server.url}/_services/cache/_apis/artifactcache/cache?keys=a&version=b`))).status).toBe(401)
    expect((await forge.fetch(new Request(`${server.url}/_services/results/blobs/nope`))).status).toBe(403)
    const discovery = await json<{ issuer: string; id_token_signing_alg_values_supported: string[] }>(await forge.fetch(new Request(`${server.url}/_services/token/.well-known/openid-configuration`)))
    expect(discovery).toMatchObject({ issuer: `${server.url}/_services/token`, id_token_signing_alg_values_supported: ['ES256'] })
  })
})
