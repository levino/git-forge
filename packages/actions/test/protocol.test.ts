import { utf8 } from '@git-forge/accounts'
import { createRepository } from '@git-forge/core'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { commitAll, git, gitEnv, initRepo, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeJitConfig, getJob, JIT_FILES, type RunnerLaunch, SERVICE_DEFINITIONS } from '../src/index.ts'
import { ADMIN_TOKEN, createTestForge, SERVICE_PATH, type TestForge } from './forge.ts'
import { type DecodedJitConfig, exchangeToken as requestToken } from './runner-client.ts'

const WORKFLOW = `name: CI
on:
  push:
    branches: [main]
env:
  GREETING: hello
jobs:
  build:
    runs-on: [self-hosted, linux]
    steps:
      - name: Say hi
        run: echo "\${{ env.GREETING }} from \${{ github.repository }}"
      - run: echo second
        env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
  deploy:
    needs: build
    runs-on: self-hosted
    steps:
      - run: echo deploy
`

const run = promisify(execFile)

const gitAsync = async (cwd: string, args: readonly string[]) => (await run('git', args, { cwd, env: { ...process.env, ...gitEnv } })).stdout

type Runner = DecodedJitConfig

let forge: TestForge
let server: RunningServer
const launches: RunnerLaunch[] = []

const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.headers as Record<string, string>) } })

const exchangeToken = async (config: Runner): Promise<string> => {
  const response = await requestToken(config)
  expect(response.status).toBe(200)
  return ((await response.json()) as { access_token: string }).access_token
}

beforeAll(async () => {
  forge = await createTestForge({
    launcher: { launch: async (launch) => void launches.push(launch) },
    secrets: async () => ({ DEPLOY_TOKEN: 'super-secret' }),
    messageWaitMs: 0,
  })
  server = await startServer(forge.handler)
  await createRepository(forge.storage, { owner: 'acme', name: 'site' })
  const source = initRepo()
  writeFile(source, '.github/workflows/ci.yml', WORKFLOW)
  writeFile(source, 'README.md', 'hello\n')
  commitAll(source, 'add workflow')
  const remote = `${server.url.replace('://', `://admin:${ADMIN_TOKEN}@`)}/acme/site.git`
  await gitAsync(source, ['push', '-q', remote, 'main'])
})

afterAll(async () => {
  await server?.close()
})

describe('Actions service protocol', () => {
  it('queues a run on push and launches a JIT runner for the first job only', () => {
    expect(forge.runs).toHaveLength(1)
    expect(forge.runs[0]!.jobs.map((job) => [job.job_key, job.status])).toEqual([
      ['build', 'queued'],
      ['deploy', 'pending'],
    ])
    expect(launches).toHaveLength(1)
    expect(launches[0]!.labels).toEqual(['self-hosted', 'linux'])
  })

  it('encodes the three runner files into the JIT config', () => {
    const config = decodeJitConfig(launches[0]!.encodedJitConfig) as Runner
    expect(Object.keys(config).sort()).toEqual([JIT_FILES.credentials, JIT_FILES.rsaParameters, JIT_FILES.runner].sort())
    expect(config['.runner']).toMatchObject({ PoolId: 1, ServerUrl: `${server.url}${SERVICE_PATH}`, GitHubUrl: `${server.url}/acme/site`, Ephemeral: true, DisableUpdate: true })
    expect(config['.credentials']).toMatchObject({ Scheme: 'OAuth', Data: { authorizationUrl: `${server.url}${SERVICE_PATH}/_apis/v1/auth/` } })
    expect(Object.keys(config['.credentials_rsaparams']).sort()).toEqual(['d', 'dp', 'dq', 'exponent', 'inverseQ', 'modulus', 'p', 'q'])
  })

  it('publishes service locations via connectionData', async () => {
    const response = await call(`${SERVICE_PATH}/_apis/connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1`)
    const body = (await response.json()) as { locationServiceData: { serviceDefinitions: { identifier: string; relativePath: string }[] } }
    expect(body.locationServiceData.serviceDefinitions.map((definition) => definition.identifier)).toEqual(SERVICE_DEFINITIONS.map((definition) => definition.id))
    const options = await call(`${SERVICE_PATH}/_apis/`, { method: 'OPTIONS' })
    expect(((await options.json()) as { count: number }).count).toBe(SERVICE_DEFINITIONS.length)
  })

  it('rejects assertions signed with another key and unauthenticated calls with a Bearer challenge', async () => {
    const config = decodeJitConfig(launches[0]!.encodedJitConfig) as Runner
    const other = decodeJitConfig(
      ((await (
        await call('/api/v3/repos/acme/site/actions/runners/generate-jitconfig', {
          method: 'POST',
          token: ADMIN_TOKEN,
          body: JSON.stringify({ name: 'other', runner_group_id: 1, labels: ['x'] }),
        })
      ).json()) as { encoded_jit_config: string }).encoded_jit_config,
    ) as Runner
    const forged = { ...config, '.credentials_rsaparams': other['.credentials_rsaparams'] }
    await expect(exchangeToken(forged)).rejects.toThrow()
    const response = await call(`${SERVICE_PATH}/_apis/v1/AgentSession/1`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  it('runs a job through session, message, renew, timeline, logs and completion', async () => {
    const config = decodeJitConfig(launches[0]!.encodedJitConfig) as Runner
    const crashed = await exchangeToken(config)
    expect(crashed.split('.').map((part, index) => (index < 2 ? Object.keys(JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))).length > 0 : part.length > 0))).toEqual([true, true, true])
    const agentId = config['.runner']['AgentId']
    const openSession = async (token: string) =>
      ((await (await call(`${SERVICE_PATH}/_apis/v1/AgentSession/1`, { method: 'POST', token, body: JSON.stringify({ ownerName: 'test', agent: { id: agentId } }) })).json()) as { sessionId: string })
        .sessionId
    const first = await openSession(crashed)
    expect((await call(`${SERVICE_PATH}/_apis/v1/Message/1?sessionId=${first}`, { token: crashed })).status).toBe(200)
    expect(await call(`${SERVICE_PATH}/_apis/v1/AgentSession/1/${first}`, { method: 'DELETE', token: crashed })).toHaveProperty('status', 204)
    const token = await exchangeToken(config)
    const session = { sessionId: await openSession(token) }
    const messageResponse = await call(`${SERVICE_PATH}/_apis/v1/Message/1?sessionId=${session.sessionId}&status=Online`, { token })
    expect(messageResponse.status).toBe(200)
    const message = (await messageResponse.json()) as { messageId: number; messageType: string; body: string }
    expect(message.messageType).toBe('PipelineAgentJobRequest')
    const job = JSON.parse(message.body)
    expect(job.jobName).toBe('build')
    expect(job.steps[0]).toMatchObject({
      type: 'action',
      reference: { type: 'script' },
      contextName: '__run',
      displayNameToken: 'Say hi',
      condition: 'success()',
      inputs: { type: 2, map: [{ Key: 'script', Value: { type: 3, expr: "format('echo \"{0} from {1}\"', env.GREETING, github.repository)" } }] },
    })
    expect(job.steps[1]).toMatchObject({ contextName: '__run_2', environment: { type: 2, map: [{ Key: 'TOKEN', Value: { type: 3, expr: 'secrets.DEPLOY_TOKEN' } }] } })
    expect(job.environmentVariables).toEqual([{ type: 2, map: [{ Key: 'GREETING', Value: 'hello' }] }])
    expect(job.variables['DEPLOY_TOKEN']).toEqual({ value: 'super-secret', isSecret: true })
    const endpoint = job.resources.endpoints[0]
    expect(endpoint).toMatchObject({ name: 'SystemVssConnection', url: `${server.url}${SERVICE_PATH}` })
    const runtimeToken = endpoint.authorization.parameters.AccessToken as string
    expect(JSON.parse(atob(runtimeToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))).toMatchObject({ sub: 'runtime', orchid: job.jobId })
    const githubToken = job.variables['system.github.token'].value as string
    expect(await call(`${SERVICE_PATH}/_apis/v1/Message/1/${message.messageId}?sessionId=${session.sessionId}`, { method: 'DELETE', token })).toHaveProperty('status', 204)

    const renew = await call(`${SERVICE_PATH}/_apis/v1/AgentRequest/1/${job.requestId}?lockToken=00000000-0000-0000-0000-000000000000`, {
      method: 'PATCH',
      token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: job.requestId }),
    })
    expect(renew.status).toBe(200)
    expect(((await renew.json()) as { lockedUntil: string }).lockedUntil).toMatch(/^\d{4}-/)
    expect((await getJob(forge.db, job.requestId))!.status).toBe('in_progress')

    const plan = `${SERVICE_PATH}/_apis/v1/%s/${job.plan.scopeIdentifier}/${job.plan.planType}/${job.plan.planId}`
    const planPath = (area: string) => plan.replace('%s', area)
    const timeline = await call(`${planPath('Timeline')}/${job.timeline.id}`, {
      method: 'PATCH',
      token: runtimeToken,
      body: JSON.stringify({ count: 1, value: [{ id: job.jobId, name: 'build', state: 'inProgress' }] }),
    })
    expect(((await timeline.json()) as { value: unknown[] }).value).toEqual([{ id: job.jobId, name: 'build', state: 'inProgress' }])
    const log = (await (await call(planPath('Logfiles'), { method: 'POST', token: runtimeToken, body: JSON.stringify({ path: 'logs/1' }) })).json()) as { id: number }
    const content = utf8('2026-10-18T00:00:00.0000000Z hello from acme/site\n')
    expect(await call(`${planPath('Logfiles')}/${log.id}`, { method: 'POST', token: runtimeToken, headers: { 'Content-Type': 'application/octet-stream' }, body: content })).toHaveProperty(
      'status',
      200,
    )
    expect(
      await call(`${planPath('TimeLineWebConsoleLog')}/${job.timeline.id}/${job.steps[0].id}`, {
        method: 'POST',
        token: runtimeToken,
        body: JSON.stringify({ value: ['hello'], stepId: job.steps[0].id, startLine: 1, count: 1 }),
      }),
    ).toHaveProperty('status', 200)
    expect(await call(`${SERVICE_PATH}/_apis/v1/Timeline/${job.plan.scopeIdentifier}/${job.plan.planType}/${crypto.randomUUID()}/${job.timeline.id}`, { method: 'PATCH', token: runtimeToken, body: '{}' })).toHaveProperty(
      'status',
      401,
    )

    const clone = tempDir()
    await gitAsync(clone, ['clone', '-q', `${server.url.replace('://', `://x-access-token:${githubToken}@`)}/acme/site.git`, '.'])
    expect(git(clone, ['log', '--format=%s']).trim()).toBe('add workflow')
    git(clone, ['commit', '-q', '--allow-empty', '-m', 'nope'])
    await expect(gitAsync(clone, ['push', '-q', 'origin', 'main'])).rejects.toThrow()

    expect(await call(planPath('FinishJob'), { method: 'POST', token: runtimeToken, body: JSON.stringify({ name: 'JobCompleted', jobId: job.jobId, requestId: job.requestId, result: 'succeeded' }) })).toHaveProperty(
      'status',
      200,
    )
    expect(await call(`${planPath('Logfiles')}`, { method: 'POST', token: runtimeToken, body: '{}' })).toHaveProperty('status', 401)
    expect((await getJob(forge.db, job.requestId))!).toMatchObject({ status: 'completed', conclusion: 'success' })
    expect(launches).toHaveLength(2)

    const runs = (await (await call(`/api/v3/repos/acme/site/actions/runs`, { token: ADMIN_TOKEN })).json()) as { workflow_runs: { status: string }[] }
    expect(runs.workflow_runs[0]!.status).toBe('queued')
    const logs = await call(`/api/v3/repos/acme/site/actions/jobs/${job.requestId}/logs`, { token: ADMIN_TOKEN })
    expect(await logs.text()).toContain('hello from acme/site')

    const empty = await call(`${SERVICE_PATH}/_apis/v1/Message/1?sessionId=${session.sessionId}`, { token })
    expect(empty.status).toBe(204)
    expect(await call(`${SERVICE_PATH}/_apis/v1/AgentSession/1/${session.sessionId}`, { method: 'DELETE', token })).toHaveProperty('status', 204)
  })

  it('skips dependent jobs when a need fails', async () => {
    const config = decodeJitConfig(launches[1]!.encodedJitConfig) as Runner
    const token = await exchangeToken(config)
    const session = (await (await call(`${SERVICE_PATH}/_apis/v1/AgentSession/1`, { method: 'POST', token, body: JSON.stringify({ ownerName: 'test' }) })).json()) as { sessionId: string }
    const message = (await (await call(`${SERVICE_PATH}/_apis/v1/Message/1?sessionId=${session.sessionId}`, { token })).json()) as { body: string }
    const job = JSON.parse(message.body)
    expect(job.jobName).toBe('deploy')
    const response = await call(`${SERVICE_PATH}/_apis/v1/AgentRequest/1/${job.requestId}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify({ requestId: job.requestId, finishTime: new Date().toISOString(), result: 2 }),
    })
    expect(((await response.json()) as { result: string }).result).toBe('failed')
    const run = (await (await call(`/api/v3/repos/acme/site/actions/runs/${forge.runs[0]!.runId}`, { token: ADMIN_TOKEN })).json()) as { status: string; conclusion: string }
    expect(run).toMatchObject({ status: 'completed', conclusion: 'failure' })
  })
})

describe('GHES runner REST API', () => {
  it('manages runners and requires authorization', async () => {
    expect(await call('/api/v3/repos/acme/site/actions/runners')).toHaveProperty('status', 404)
    const list = (await (await call('/api/v3/repos/acme/site/actions/runners?name=other', { token: ADMIN_TOKEN })).json()) as { total_count: number; runners: { id: number }[] }
    expect(list.total_count).toBe(1)
    const conflict = await call('/api/v3/repos/acme/site/actions/runners/generate-jitconfig', {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: JSON.stringify({ name: 'other', runner_group_id: 1, labels: ['x'] }),
    })
    expect(conflict.status).toBe(409)
    expect(await call(`/api/v3/repos/acme/site/actions/runners/${list.runners[0]!.id}`, { method: 'DELETE', token: ADMIN_TOKEN })).toHaveProperty('status', 204)
    expect(await call(`/api/v3/repos/acme/site/actions/runners/${list.runners[0]!.id}`, { token: ADMIN_TOKEN })).toHaveProperty('status', 404)
  })

  it('registers a classic runner with a registration token', async () => {
    const { token } = (await (await call('/api/v3/repos/acme/site/actions/runners/registration-token', { method: 'POST', token: ADMIN_TOKEN })).json()) as { token: string }
    const registration = await call('/api/v3/actions/runner-registration', {
      method: 'POST',
      headers: { Authorization: `RemoteAuth ${token}` },
      body: JSON.stringify({ url: `${server.url}/acme/site`, runner_event: 'register' }),
    })
    const tenant = (await registration.json()) as { url: string; token: string; token_schema: string }
    expect(tenant).toMatchObject({ url: `${server.url}${SERVICE_PATH}`, token_schema: 'OAuthAccessToken' })
    const pools = (await (await call(`${SERVICE_PATH}/_apis/v1/AgentPools`, { token: tenant.token })).json()) as { value: { id: number }[] }
    expect(pools.value[0]!.id).toBe(1)
    const agent = await call(`${SERVICE_PATH}/_apis/v1/Agent/1`, {
      method: 'POST',
      token: tenant.token,
      body: JSON.stringify({ name: 'classic', labels: [{ name: 'self-hosted' }], authorization: { publicKey: { exponent: 'AQAB', modulus: 'qq+/' } } }),
    })
    expect(((await agent.json()) as { authorization: { authorizationUrl: string } }).authorization.authorizationUrl).toBe(`${server.url}${SERVICE_PATH}/_apis/v1/auth/`)
  })
})
