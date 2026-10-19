import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRepository } from '@git-forge/core'
import { commitAll, gitEnv, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateRunnerKey, listCurrentJobs, type RunnerLaunch } from '../src/index.ts'
import { ADMIN_TOKEN, createTestForge, SERVICE_PATH, type TestForge } from './forge.ts'
import { FakeRunner } from './runner-client.ts'

const run = promisify(execFile)

let forge: TestForge
let server: RunningServer
const launches: RunnerLaunch[] = []
const events: string[] = []

const api = async (path: string, method = 'GET', body?: unknown, token = ADMIN_TOKEN) => {
  const response = await fetch(`${server.url}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, body: response.status === 204 ? null : ((await response.json()) as any) }
}

const push = async (name: string, workflow: string) => {
  await createRepository(forge.storage, { owner: 'acme', name })
  const source = initRepo()
  writeFile(source, '.github/workflows/ci.yml', workflow)
  commitAll(source, 'ci')
  await run('git', ['push', '-q', `${server.url.replace('://', `://admin:${ADMIN_TOKEN}@`)}/acme/${name}.git`, 'main'], { cwd: source, env: { ...process.env, ...gitEnv } })
  return forge.runs.at(-1)!.runId
}

const jit = async (path: string, name: string, labels: string[]) => {
  const generated = await api(`${path}/actions/runners/generate-jitconfig`, 'POST', { name, runner_group_id: 1, labels })
  expect(generated.status).toBe(201)
  return generated.body as { runner: { id: number }; encoded_jit_config: string }
}

beforeAll(async () => {
  forge = await createTestForge({
    launcher: { labels: ['self-hosted', 'linux'], launch: async (launch) => void launches.push(launch) },
    onJobEvent: async (action, job) => void events.push(`${action} ${job.display_name}`),
    messageWaitMs: 0,
  })
  server = await startServer(forge.handler)
})

afterAll(async () => {
  await server?.close()
})

describe('self-hosted runners and external providers', () => {
  it('launches containers only for labels the launcher serves, flags Docker jobs and emits workflow_job events', async () => {
    const runId = await push(
      'app',
      `on: push
jobs:
  plain:
    runs-on: [self-hosted, linux]
    steps: [{run: echo}]
  db:
    runs-on: [self-hosted, linux]
    container: node:22
    services:
      postgres: postgres:17
    steps: [{run: echo}]
  gpu:
    runs-on: [self-hosted, gpu]
    steps: [{run: echo}]
`,
    )
    expect(launches.map((launch) => [launch.labels.join(','), launch.docker])).toEqual([
      ['self-hosted,linux', false],
      ['self-hosted,linux', true],
    ])
    expect(events).toEqual(['queued plain', 'queued db', 'queued gpu'])
    const other = await jit('/api/v3/repos/acme/other', 'other-gpu', ['self-hosted', 'gpu'])
    expect((await (await FakeRunner.connect(server.url, SERVICE_PATH, other.encoded_jit_config)).poll()).status).not.toBe(200)
    const org = await jit('/api/v3/orgs/acme', 'org-gpu', ['self-hosted', 'gpu'])
    const runner = await FakeRunner.connect(server.url, SERVICE_PATH, org.encoded_jit_config)
    const job = await runner.take()
    expect(job.jobDisplayName).toBe('gpu')
    expect(job.message['jobContainer']).toBeUndefined()
    expect(await runner.renew(job)).toBe(200)
    const listed = await api('/api/v3/orgs/acme/actions/runners')
    expect(listed.body.runners).toMatchObject([{ id: org.runner.id, name: 'org-gpu', busy: true, runner_group_id: 1 }])
    expect(await runner.finish(job, 'succeeded')).toBe(200)
    expect(events.slice(3)).toEqual(['in_progress gpu', 'completed gpu'])
    expect((await listCurrentJobs(forge.db, runId)).find((row) => row.display_name === 'gpu')).toMatchObject({ status: 'completed', conclusion: 'success', runner_id: org.runner.id })
  })

  it('sends jobs to a matching registered runner instead of launching a container', async () => {
    const before = launches.length
    await jit('/api/v3/repos/acme/site', 'laptop', ['self-hosted', 'linux', 'big'])
    await push('site', 'on: push\njobs:\n  build:\n    runs-on: [self-hosted, linux]\n    steps: [{run: echo}]\n')
    expect(launches.length).toBe(before)
  })

  it('registers and removes runners with registration tokens at repository and organization level', async () => {
    for (const path of ['/api/v3/repos/acme/app', '/api/v3/orgs/acme']) {
      const issued = await api(`${path}/actions/runners/registration-token`, 'POST')
      expect(issued.status).toBe(201)
      const tenant = await fetch(`${server.url}/api/v3/actions/runner-registration`, {
        method: 'POST',
        headers: { Authorization: `RemoteAuth ${issued.body.token}` },
        body: JSON.stringify({ url: `${server.url}/acme`, runner_event: 'register' }),
      })
      expect(await tenant.json()).toMatchObject({ url: `${server.url}${SERVICE_PATH}`, use_v2_flow: false })
      const key = await generateRunnerKey()
      const name = `registered-${path.split('/')[3]}`
      const added = await api(
        `${SERVICE_PATH}/_apis/v1/Agent/1`,
        'POST',
        { name, labels: [{ name: 'self-hosted' }, { name: 'Linux' }], authorization: { publicKey: { exponent: key.rsaParameters.exponent, modulus: key.rsaParameters.modulus } } },
        issued.body.token,
      )
      expect(added.status).toBe(200)
      const runners = await api(`${path}/actions/runners?name=${name}`)
      expect(runners.body.runners).toMatchObject([{ id: added.body.id, labels: [{ name: 'self-hosted', type: 'read-only' }, { name: 'Linux', type: 'read-only' }] }])
      const removal = await api(`${path}/actions/runners/remove-token`, 'POST')
      expect((await api(`${SERVICE_PATH}/_apis/v1/Agent/1/${added.body.id}`, 'DELETE', undefined, removal.body.token)).status).toBe(204)
      expect((await api(`${path}/actions/runners?name=${name}`)).body.total_count).toBe(0)
    }
  })

  it('manages labels and the default runner group', async () => {
    const { runner } = await jit('/api/v3/repos/acme/app', 'labelled', ['self-hosted', 'one'])
    const labels = `/api/v3/repos/acme/app/actions/runners/${runner.id}/labels`
    const names = (body: { labels: { name: string }[] }) => body.labels.map((label) => label.name)
    expect(names((await api(labels, 'POST', { labels: ['two', 'ONE'] })).body)).toEqual(['self-hosted', 'ONE', 'two'])
    expect(names((await api(labels, 'PUT', { labels: ['three'] })).body)).toEqual(['self-hosted', 'three'])
    expect((await api(`${labels}/self-hosted`, 'DELETE')).status).toBe(422)
    expect(names((await api(`${labels}/three`, 'DELETE')).body)).toEqual(['self-hosted'])
    expect((await api(`/api/v3/orgs/acme/actions/runners/${runner.id}`)).status).toBe(404)
    expect((await api('/api/v3/orgs/acme/actions/runner-groups')).body).toMatchObject({ total_count: 1, runner_groups: [{ id: 1, name: 'Default', default: true }] })
    expect((await api('/api/v3/orgs/acme/actions/runner-groups', 'GET', undefined, 'wrong')).status).toBe(404)
    expect((await api('/api/v3/repos/acme/app/actions/runners/generate-jitconfig', 'POST', { name: 'grouped', runner_group_id: 7, labels: ['x'] })).status).toBe(422)
    expect((await api(`/api/v3/repos/acme/app/actions/runners/${runner.id}`, 'DELETE')).status).toBe(204)
    expect((await jit('/api/v3/repos/acme/app', 'labelled', ['self-hosted'])).runner.id).not.toBe(runner.id)
  })
})
