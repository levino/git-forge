import { consolePrefix, jobPrefix } from '@git-forge/actions'
import type { Principal, UserPrincipal } from '@git-forge/accounts'
import { utf8 } from '@git-forge/core'
import { commitAll, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UiSession } from '../../src/app.ts'
import Runs from '../../src/pages/[owner]/[repo]/actions/index.astro'
import Run from '../../src/pages/[owner]/[repo]/actions/runs/[id]/index.astro'
import Job from '../../src/pages/[owner]/[repo]/actions/runs/[id]/jobs/[job]/index.astro'
import * as JobLog from '../../src/pages/[owner]/[repo]/actions/runs/[id]/jobs/[job]/log.txt.ts'
import { git } from '../e2e/history.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const ANONYMOUS: Principal = { kind: 'anonymous' }

let server: RunningServer
let forge: NodeForge
let container: AstroContainer
let runId: number
let jobId: string
let admin: UserPrincipal
let reader: UserPrincipal

type RenderOptions = { readonly routeType?: 'endpoint'; readonly principal?: Principal; readonly form?: Record<string, string>; readonly search?: string }

const render = async (page: Parameters<AstroContainer['renderToResponse']>[0], params: Record<string, string>, options: RenderOptions = {}) => {
  const principal = options.principal ?? ANONYMOUS
  const session: UiSession | null = principal.kind === 'user' ? { principal, csrf: 'csrf-token', sessionId: 'session-1' } : null
  const url = `${server.url}/${params.owner}/${params.repo}/actions${options.search ?? ''}`
  const response = await container.renderToResponse(page, {
    request: options.form
      ? new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: 'csrf-token', ...options.form }) })
      : new Request(url),
    params,
    locals: { forge: { ...forge.services, verifySessionWrite: async () => session }, principal, session },
    partial: false,
    ...(options.routeType ? { routeType: options.routeType } : {}),
  })
  return { status: response.status, headers: response.headers, location: response.headers.get('Location'), html: await response.text() }
}

const principalFor = async (token: string) => (await forge.services.authenticate(new Request(server.url, { headers: { Authorization: `Bearer ${token}` } }))) as UserPrincipal

beforeAll(async () => {
  let handler = (_request: Request) => Promise.resolve(new Response('starting', { status: 503 }))
  server = await startServer((request) => handler(request))
  forge = await nodeForge({ publicUrl: server.url, actions: { instanceId: '00000000-0000-0000-0000-000000000000' } })
  handler = forge.fetch
  const token = await bootstrap(forge, server.url, 'admin')
  expect((await call(forge, server.url, 'POST', '/api/repos', token, { owner: 'admin', name: 'ci', visibility: 'public' })).status).toBe(201)
  expect((await call(forge, server.url, 'POST', '/api/repos', token, { owner: 'admin', name: 'other', visibility: 'public' })).status).toBe(201)
  const source = initRepo()
  writeFile(source, '.github/workflows/ci.yml', 'name: Build\non: push\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo hi\n')
  commitAll(source, 'workflow')
  await git(source, ['-c', `http.extraHeader=Authorization: Bearer ${token}`, 'push', '-q', `${server.url}/admin/ci.git`, 'main'])
  const runs = (await (await call(forge, server.url, 'GET', '/api/v3/repos/admin/ci/actions/runs', token)).json()) as { workflow_runs: { id: number }[] }
  runId = runs.workflow_runs[0]!.id
  const jobs = (await (await call(forge, server.url, 'GET', `/api/v3/repos/admin/ci/actions/runs/${runId}/jobs`, token)).json()) as { jobs: { id: number | string; runner_name: string | null }[] }
  const found = await forge.services.actions.run({ owner: 'admin', name: 'ci' }, runId)
  jobId = found!.jobs[0]!.id
  expect(jobs.jobs).toHaveLength(1)
  const key = `${consolePrefix(jobPrefix('admin', 'ci', jobId))}00000001`
  const line = utf8('\u001b[32mStarting\u001b[0m <build>\r\n')
  await forge.storage.put(key, line, line.length)
  admin = await principalFor(token)
  expect((await call(forge, server.url, 'POST', '/api/admin/users', token, { login: 'reader' })).status).toBe(201)
  reader = await principalFor(((await (await call(forge, server.url, 'POST', '/api/admin/users/reader/tokens', token, { scopes: ['repo:admin'] })).json()) as { token: string }).token)
  container = await AstroContainer.create()
}, 60_000)

afterAll(async () => {
  await server.close()
})

describe('actions pages', () => {
  it('lists runs and their jobs', async () => {
    const runs = await render(Runs, { owner: 'admin', repo: 'ci' })
    expect(runs.html).toContain('Build')
    expect(runs.html).toContain(`href="/admin/ci/actions/runs/${runId}"`)
    const run = await render(Run, { owner: 'admin', repo: 'ci', id: String(runId) })
    expect(run.html).toContain('>test<')
    expect(run.html).toContain('Queued')
    expect(run.html).not.toContain('Cancel run')
    expect(run.headers.get('Refresh')).toBe('5')
  })

  it('shows the live log without escape codes and polls while the job runs', async () => {
    const job = await render(Job, { owner: 'admin', repo: 'ci', id: String(runId), job: jobId })
    expect(job.status).toBe(200)
    expect(job.html).toContain('Starting &lt;build&gt;')
    expect(job.html).not.toContain('\u001b')
    expect(job.html).toContain(`data-log-url="/admin/ci/actions/runs/${runId}/jobs/${jobId}/log.txt"`)
    const log = await render(JobLog as never, { owner: 'admin', repo: 'ci', id: String(runId), job: jobId }, { routeType: 'endpoint' })
    expect(log.html).toBe('Starting <build>\n')
    expect(log.headers.get('X-Job-Done')).toBe('0')
  })

  it('does not show runs through another repository', async () => {
    expect((await render(Run, { owner: 'admin', repo: 'other', id: String(runId) })).status).toBe(404)
    expect((await render(JobLog as never, { owner: 'admin', repo: 'other', id: String(runId), job: jobId }, { routeType: 'endpoint' })).status).toBe(404)
  })

  it('filters runs by workflow', async () => {
    const runs = await render(Runs, { owner: 'admin', repo: 'ci' }, { search: '?workflow=.github%2Fworkflows%2Fci.yml' })
    expect(runs.html).toContain('aria-label="Workflows"')
    expect(runs.html).toMatch(/aria-current="page"[^>]*>\s*Build/)
    expect(runs.html).toContain(`href="/admin/ci/actions/runs/${runId}"`)
    const unknown = await render(Runs, { owner: 'admin', repo: 'ci' }, { search: '?workflow=nope.yml' })
    expect(unknown.html).toMatch(/aria-current="page"[^>]*>All workflows/)
  })

  it('cancels and re-runs runs for writers only', async () => {
    const params = { owner: 'admin', repo: 'ci', id: String(runId) }
    expect((await render(Run, params, { principal: reader })).html).not.toContain('Cancel run')
    const refused = await render(Run, params, { principal: reader, form: { action: 'cancel' } })
    expect(refused.status).toBe(403)
    expect(refused.html).toContain('write access is required')
    expect((await render(Run, params, { form: { action: 'cancel' } })).status).toBe(403)
    expect((await render(Run, params, { principal: admin })).html).toContain('Cancel run')
    expect(await render(Run, params, { principal: admin, form: { action: 'cancel' } })).toMatchObject({ status: 303, location: `/admin/ci/actions/runs/${runId}` })
    const cancelled = await render(Run, params, { principal: admin })
    expect(cancelled.html).toContain('Cancelled')
    expect(cancelled.html).toContain('Re-run all jobs')
    expect(cancelled.html).toContain('Re-run failed jobs')
    expect(cancelled.headers.get('Refresh')).toBeNull()
    expect((await render(Job, { ...params, job: jobId }, { principal: admin })).html).toContain('Re-run job')
    expect(await render(Run, params, { principal: admin, form: { action: 'rerun-failed' } })).toMatchObject({ status: 303 })
    const rerun = await render(Run, params, { principal: admin })
    expect(rerun.html).toContain('Attempt 2')
    expect(rerun.html).toContain('Queued')
    expect(rerun.html).not.toContain('Cancelled')
    const busy = await render(Run, params, { principal: admin, form: { action: 'rerun' } })
    expect(busy.status).toBe(409)
    expect(busy.html).toContain('still in progress')
    expect((await render(Run, { ...params, repo: 'other' }, { principal: admin, form: { action: 'cancel' } })).status).toBe(404)
  })
})
