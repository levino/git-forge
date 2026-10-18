import { consolePrefix, jobPrefix } from '@git-forge/actions'
import type { Principal } from '@git-forge/accounts'
import { utf8 } from '@git-forge/core'
import { commitAll, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

const render = async (page: Parameters<AstroContainer['renderToResponse']>[0], params: Record<string, string>, extra: { routeType?: 'endpoint' } = {}) => {
  const response = await container.renderToResponse(page, {
    request: new Request(`${server.url}/`),
    params,
    locals: { forge: forge.services, principal: ANONYMOUS, session: null },
    partial: false,
    ...extra,
  })
  return { status: response.status, headers: response.headers, html: await response.text() }
}

beforeAll(async () => {
  let handler = (_request: Request) => Promise.resolve(new Response('starting', { status: 503 }))
  server = await startServer((request) => handler(request))
  forge = await nodeForge({ publicUrl: server.url, actions: { instanceId: '00000000-0000-0000-0000-000000000000' } })
  handler = forge.fetch
  const admin = await bootstrap(forge, server.url, 'admin')
  expect((await call(forge, server.url, 'POST', '/api/repos', admin, { owner: 'admin', name: 'ci', visibility: 'public' })).status).toBe(201)
  expect((await call(forge, server.url, 'POST', '/api/repos', admin, { owner: 'admin', name: 'other', visibility: 'public' })).status).toBe(201)
  const source = initRepo()
  writeFile(source, '.github/workflows/ci.yml', 'name: Build\non: push\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo hi\n')
  commitAll(source, 'workflow')
  await git(source, ['-c', `http.extraHeader=Authorization: Bearer ${admin}`, 'push', '-q', `${server.url}/admin/ci.git`, 'main'])
  const runs = (await (await call(forge, server.url, 'GET', '/api/v3/repos/admin/ci/actions/runs', admin)).json()) as { workflow_runs: { id: number }[] }
  runId = runs.workflow_runs[0]!.id
  const jobs = (await (await call(forge, server.url, 'GET', `/api/v3/repos/admin/ci/actions/runs/${runId}/jobs`, admin)).json()) as { jobs: { id: number | string; runner_name: string | null }[] }
  const found = await forge.services.actions.run({ owner: 'admin', name: 'ci' }, runId)
  jobId = found!.jobs[0]!.id
  expect(jobs.jobs).toHaveLength(1)
  const key = `${consolePrefix(jobPrefix('admin', 'ci', jobId))}00000001`
  const line = utf8('\u001b[32mStarting\u001b[0m <build>\r\n')
  await forge.storage.put(key, line, line.length)
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
})
