import { mkdirSync, writeFileSync } from 'node:fs'
import { decodeConfig, exchangeToken } from '@git-forge/actions/test/runner-client.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitFails, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const BOOTSTRAP_TOKEN = `e2e-${crypto.randomUUID()}`

let dev: WranglerDev
let admin: string

const call = (path: string, init: RequestInit = {}, token = admin) =>
  fetch(`${dev.url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } })

beforeAll(async () => {
  dev = await startWranglerDev({ vars: { BOOTSTRAP_TOKEN, ACTIONS_SECRETS: '{"DEPLOY_TOKEN":"from-the-instance"}' } })
  const bootstrapped = await call('/api/bootstrap', { method: 'POST', body: JSON.stringify({ login: 'e2e' }) }, BOOTSTRAP_TOKEN)
  admin = ((await bootstrapped.json()) as { token: string }).token
}, 90_000)

afterAll(async () => {
  await dev?.stop()
})

describe('CI on wrangler dev', () => {
  it('queues a run on push and hands the job to a JIT runner over the Actions protocol', async () => {
    expect((await call('/api/repos', { method: 'POST', body: JSON.stringify({ owner: 'e2e', name: 'ci' }) })).status).toBe(201)
    const repo = tempDir()
    await git(repo, ['init', '-q', '-b', 'main'])
    mkdirSync(`${repo}/.github/workflows`, { recursive: true })
    writeFileSync(`${repo}/.github/workflows/ci.yml`, 'on: push\njobs:\n  hello:\n    runs-on: [self-hosted, e2e]\n    steps:\n      - run: echo hello\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'workflow'])
    await git(repo, ['push', '-q', `${dev.url.replace('http://', `http://git:${admin}@`)}/e2e/ci.git`, 'main'])

    const runs = (await (await call('/api/v3/repos/e2e/ci/actions/runs')).json()) as { workflow_runs: { id: number; status: string }[] }
    expect(runs.workflow_runs).toHaveLength(1)
    expect(runs.workflow_runs[0]!.status).toBe('queued')
    expect((await call('/api/v3/repos/e2e/ci/actions/runs', {}, 'wrong')).status).toBe(404)

    const generated = await call('/api/v3/repos/e2e/ci/actions/runners/generate-jitconfig', {
      method: 'POST',
      body: JSON.stringify({ name: 'e2e-runner', runner_group_id: 1, labels: ['self-hosted', 'e2e'] }),
    })
    expect(generated.status).toBe(201)
    const config = decodeConfig(((await generated.json()) as { encoded_jit_config: string }).encoded_jit_config)
    expect(config['.runner']['ServerUrl']).toBe(`${dev.url}/_services/actions`)
    const token = ((await (await exchangeToken(config)).json()) as { access_token: string }).access_token
    expect((await fetch(`${dev.url}/_services/actions/_apis/connectionData?connectOptions=1`)).status).toBe(200)
    const session = (await (
      await call('/_services/actions/_apis/v1/AgentSession/1', { method: 'POST', body: JSON.stringify({ ownerName: 'e2e', agent: { id: config['.runner']['AgentId'] } }) }, token)
    ).json()) as { sessionId: string }
    const message = await call(`/_services/actions/_apis/v1/Message/1?sessionId=${session.sessionId}`, {}, token)
    expect(message.status).toBe(200)
    const job = JSON.parse(((await message.json()) as { body: string }).body) as {
      jobName: string
      requestId: number
      variables: Record<string, { value: string }>
    }
    expect(job.jobName).toBe('hello')
    expect(job.variables['DEPLOY_TOKEN']!.value).toBe('from-the-instance')
    const renewed = await call(`/_services/actions/_apis/v1/AgentRequest/1/${job.requestId}`, { method: 'PATCH', body: JSON.stringify({ requestId: job.requestId }) }, token)
    expect(renewed.status).toBe(200)
    const jobs = (await (await call(`/api/v3/repos/e2e/ci/actions/runs/${runs.workflow_runs[0]!.id}/jobs`)).json()) as { jobs: { status: string }[] }
    expect(jobs.jobs[0]!.status).toBe('in_progress')

    const githubToken = job.variables['system.github.token']!.value
    await git(tempDir(), ['clone', '-q', `${dev.url.replace('http://', `http://x-access-token:${githubToken}@`)}/e2e/ci.git`, 'out'])
    expect(await gitFails(tempDir(), ['clone', '-q', `${dev.url.replace('http://', `http://x-access-token:${githubToken}x@`)}/e2e/ci.git`, 'out'])).toMatch(/401|Authentication failed/i)
  })
})
