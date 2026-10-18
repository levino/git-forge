import { commitAll, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateEs256Key, importEs256Key } from '@git-forge/actions'
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
