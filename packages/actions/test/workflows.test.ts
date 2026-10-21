import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { commitTarball, createRepository, ObjectDatabase, readAll } from '@git-forge/core'
import { commitAll, gitEnv, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  actionsTick,
  getJob,
  getRun,
  importSecretsKey,
  listCurrentJobs,
  queueRunsForPullRequest,
  reapActions,
  type RunnerLaunch,
  runnerStopped,
} from '../src/index.ts'
import { ADMIN_TOKEN, createTestForge, REVIEWER_TOKEN, SERVICE_PATH, type TestForge, type TestForgeOptions } from './forge.ts'
import { FakeRunner } from './runner-client.ts'

const run = promisify(execFile)

type Harness = {
  readonly forge: TestForge
  readonly server: RunningServer
  readonly launches: RunnerLaunch[]
  readonly clock: { offset: number }
  readonly push: (files: Record<string, string>, branch?: string) => Promise<string>
  readonly api: (path: string, init?: RequestInit & { token?: string }) => Promise<Response>
  readonly runner: (index: number) => Promise<FakeRunner>
}

const servers: RunningServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const harness = async (options: TestForgeOptions = {}): Promise<Harness> => {
  const launches: RunnerLaunch[] = []
  const clock = { offset: 0 }
  const forge = await createTestForge({ launcher: { launch: async (launch) => void launches.push(launch) }, messageWaitMs: 0, now: () => Date.now() + clock.offset, ...options })
  const server = await startServer(forge.handler)
  servers.push(server)
  await createRepository(forge.storage, { owner: 'acme', name: 'site' })
  const source = initRepo()
  const remote = `${server.url.replace('://', `://admin:${ADMIN_TOKEN}@`)}/acme/site.git`
  return {
    forge,
    server,
    launches,
    clock,
    push: async (files, branch = 'main') => {
      for (const [path, content] of Object.entries(files)) writeFile(source, path, content)
      const sha = commitAll(source, 'change')
      await run('git', ['push', '-q', remote, `HEAD:refs/heads/${branch}`], { cwd: source, env: { ...process.env, ...gitEnv } })
      return sha
    },
    api: (path, init = {}) =>
      fetch(`${server.url}/api/v3${path}`, { ...init, headers: { Authorization: `Bearer ${init.token ?? ADMIN_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } }),
    runner: (index) => FakeRunner.connect(server.url, SERVICE_PATH, launches[index]!.encodedJitConfig),
  }
}

const jobs = async (h: Harness, runId: number) => (await listCurrentJobs(h.forge.db, runId)).map((job) => [job.display_name, job.status, job.conclusion])

const contextValue = (data: any, ...path: string[]): any => {
  let current = data
  for (const key of path) current = current?.d?.find((entry: { k: string }) => entry.k === key)?.v
  return current
}

describe('workflow semantics', () => {
  it('passes outputs across needs, expands a matrix from them, throttles with max-parallel and evaluates job conditions', async () => {
    const h = await harness()
    const sha = await h.push({
      '.github/workflows/ci.yml': `on: push
jobs:
  plan:
    runs-on: self-hosted
    outputs:
      targets: \${{ steps.p.outputs.targets }}
    steps:
      - id: p
        run: echo plan
  build:
    needs: plan
    runs-on: [self-hosted, '\${{ matrix.os }}']
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        os: \${{ fromJSON(needs.plan.outputs.targets) }}
        node: [22]
    steps:
      - run: echo build
  never:
    needs: plan
    if: needs.plan.outputs.targets == '[]'
    runs-on: self-hosted
    steps:
      - run: echo never
  report:
    needs: [build]
    if: always()
    name: report \${{ needs.build.result }}
    runs-on: self-hosted
    steps:
      - run: echo report
`,
    })
    const runId = h.forge.runs[0]!.runId
    expect(await jobs(h, runId)).toEqual([
      ['plan', 'queued', null],
      ['build', 'pending', null],
      ['never', 'pending', null],
      ['report', 'pending', null],
    ])
    await (await h.runner(0)).run('succeeded', { targets: '["linux","mac","win"]' })
    expect(await jobs(h, runId)).toEqual([
      ['plan', 'completed', 'success'],
      ['build (linux, 22)', 'queued', null],
      ['never', 'completed', 'skipped'],
      ['report', 'pending', null],
      ['build (mac, 22)', 'queued', null],
      ['build (win, 22)', 'pending', null],
    ])
    expect(h.launches.map((launch) => launch.labels)).toEqual([['self-hosted'], ['self-hosted', 'linux'], ['self-hosted', 'mac']])
    const linux = await (await h.runner(1)).take()
    expect(linux.jobDisplayName).toBe('build (linux, 22)')
    expect(contextValue(linux.message.contextData.matrix, 'os')).toBe('linux')
    expect(contextValue(linux.message.contextData.strategy, 'job-total')).toBe(3)
    expect(contextValue(linux.message.contextData.needs, 'plan', 'outputs', 'targets')).toBe('["linux","mac","win"]')
    await (await h.runner(2)).run('failed')
    expect((await jobs(h, runId)).find(([name]) => name === 'build (win, 22)')).toEqual(['build (win, 22)', 'queued', null])
    await (await h.runner(3)).run('succeeded')
    const linuxJob = await getJob(h.forge.db, linux.requestId)
    expect(linuxJob!.status).toBe('assigned')
    const response = await fetch(`${h.server.url}${SERVICE_PATH}/_apis/v1/AgentRequest/1/${linux.requestId}`, { method: 'GET' })
    expect(response.status).toBe(401)
    const finish = await fetch(linux.planPath('FinishJob'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${linux.runtimeToken}` },
      body: JSON.stringify({ name: 'JobCompleted', jobId: linux.jobId, requestId: linux.requestId, result: 'succeeded' }),
    })
    expect(finish.status).toBe(200)
    expect(await jobs(h, runId)).toEqual([
      ['plan', 'completed', 'success'],
      ['build (linux, 22)', 'completed', 'success'],
      ['never', 'completed', 'skipped'],
      ['report failure', 'queued', null],
      ['build (mac, 22)', 'completed', 'failure'],
      ['build (win, 22)', 'completed', 'success'],
    ])
    const report = await (await h.runner(4)).run('succeeded')
    expect(contextValue(report.message.contextData.needs, 'build', 'result')).toBe('failure')
    expect(await getRun(h.forge.db, runId)).toMatchObject({ conclusion: 'failure' })
    expect(h.forge.checks.every((check) => check.headSha === sha && check.repo === 'acme/site')).toBe(true)
    expect(h.forge.checks.map((check) => [check.name, check.status, check.conclusion])).toEqual([
      ['plan', 'completed', 'success'],
      ['build (linux, 22)', 'completed', 'success'],
      ['build (mac, 22)', 'completed', 'failure'],
      ['build (win, 22)', 'completed', 'success'],
      ['never', 'completed', 'skipped'],
      ['report failure', 'completed', 'success'],
    ])
    const runJson = (await (await h.api(`/repos/acme/site/actions/runs/${runId}`)).json()) as { status: string; conclusion: string }
    expect(runJson).toMatchObject({ status: 'completed', conclusion: 'failure' })
  })

  it('cancels the other legs on failure (fail-fast), delivers JobCancellation to a running runner and re-runs failed jobs', async () => {
    const h = await harness()
    await h.push({
      '.github/workflows/ci.yml': `on: push
jobs:
  test:
    runs-on: self-hosted
    strategy:
      matrix:
        n: [1, 2, 3]
    steps:
      - run: echo \${{ matrix.n }}
`,
    })
    const runId = h.forge.runs[0]!.runId
    expect(h.launches).toHaveLength(3)
    const first = await h.runner(0)
    const running = await first.take()
    expect(await first.renew(running)).toBe(200)
    await (await h.runner(1)).run('failed')
    expect(await jobs(h, runId)).toEqual([
      ['test (1)', 'in_progress', null],
      ['test (2)', 'completed', 'failure'],
      ['test (3)', 'completed', 'cancelled'],
    ])
    const cancellation = await first.poll()
    expect(cancellation).toMatchObject({ status: 200, messageType: 'JobCancellation', body: { jobId: running.jobId } })
    expect((await first.poll()).status).toBe(204)
    await first.finish(running, 'canceled')
    expect(await getRun(h.forge.db, runId)).toMatchObject({ conclusion: 'failure' })
    expect(await (await h.api(`/repos/acme/site/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST' })).status).toBe(201)
    expect(await jobs(h, runId)).toEqual([
      ['test (1)', 'queued', null],
      ['test (2)', 'queued', null],
      ['test (3)', 'queued', null],
    ])
    const rerun = await (await h.runner(3)).take()
    expect(contextValue(rerun.message.contextData.github, 'run_attempt')).toBe('2')
    const all = (await (await h.api(`/repos/acme/site/actions/runs/${runId}/jobs?filter=all`)).json()) as { total_count: number }
    expect(all.total_count).toBe(6)
    expect(await (await h.api(`/repos/acme/site/actions/runs/${runId}/rerun`, { method: 'POST' })).status).toBe(403)
  })

  it('cancels runs through the API, force-cancels unresponsive runners and enforces job timeouts', async () => {
    const h = await harness()
    await h.push({
      '.github/workflows/ci.yml': `on: push
jobs:
  slow:
    runs-on: self-hosted
    timeout-minutes: 1
    steps:
      - run: sleep 600
  waiting:
    runs-on: other
    steps:
      - run: echo
`,
    })
    const runId = h.forge.runs[0]!.runId
    const runner = await h.runner(0)
    const slow = await runner.take()
    await runner.renew(slow)
    h.clock.offset = 2 * 60_000
    expect((await reapActions(h.forge.dispatch(h.server.url))).timedOut).toBe(1)
    expect(await runner.poll()).toMatchObject({ messageType: 'JobCancellation', body: { jobId: slow.jobId } })
    expect(await (await h.api(`/repos/acme/site/actions/runs/${runId}/cancel`, { method: 'POST' })).status).toBe(202)
    const waiting = (await listCurrentJobs(h.forge.db, runId)).find((job) => job.job_key === 'waiting')!
    expect(waiting).toMatchObject({ status: 'completed', conclusion: 'cancelled' })
    expect(await (await h.api(`/repos/acme/site/actions/runners/${waiting.runner_id}`)).status).toBe(404)
    h.clock.offset = 10 * 60_000
    expect((await reapActions(h.forge.dispatch(h.server.url))).forceCancelled).toBe(1)
    expect(await getJob(h.forge.db, slow.requestId)).toMatchObject({ status: 'completed', conclusion: 'cancelled', cancel_reason: 'timeout' })
    expect(await getRun(h.forge.db, runId)).toMatchObject({ conclusion: 'cancelled' })
    expect(h.forge.checks.map((check) => [check.name, check.conclusion])).toEqual([
      ['slow', 'timed_out'],
      ['waiting', 'cancelled'],
    ])
    expect(await (await h.api(`/repos/acme/site/actions/runs/${runId}/cancel`, { method: 'POST' })).status).toBe(409)
  })

  it('fails jobs of dead runners, relaunches runners that never connected and requeues undelivered jobs', async () => {
    const h = await harness()
    await h.push({
      '.github/workflows/ci.yml': `on: push
jobs:
  a:
    runs-on: self-hosted
    steps: [{ run: echo a }]
  b:
    runs-on: self-hosted
    steps: [{ run: echo b }]
`,
    })
    const runId = h.forge.runs[0]!.runId
    const runner = await h.runner(0)
    const a = await runner.take()
    await runner.renew(a)
    h.clock.offset = 16 * 60_000
    const report = await reapActions(h.forge.dispatch(h.server.url))
    expect(report).toMatchObject({ abandoned: 1, requeued: 1, sessionsClosed: 1 })
    expect(await getJob(h.forge.db, a.requestId)).toMatchObject({ status: 'completed', conclusion: 'failure', cancel_reason: 'runner-lost' })
    expect(h.launches).toHaveLength(3)
    expect(h.launches[2]!.jobId).toBe(h.launches[1]!.jobId)
    h.clock.offset = 0
    const replacement = await h.runner(2)
    await replacement.run()
    expect(await jobs(h, runId)).toEqual([
      ['a', 'completed', 'failure'],
      ['b', 'completed', 'success'],
    ])
  })

  it('fails a running job at once when its runner container stops, without requeueing it', async () => {
    const h = await harness()
    await h.push({ '.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    runs-on: self-hosted\n    steps: [{ run: echo a }]\n' })
    const runId = h.forge.runs[0]!.runId
    const jobId = h.launches[0]!.jobId
    expect(await runnerStopped(h.forge.dispatch(h.server.url), jobId)).toBe(false)
    const runner = await h.runner(0)
    const a = await runner.take()
    await runner.renew(a)
    expect(await runnerStopped(h.forge.dispatch(h.server.url), jobId)).toBe(true)
    expect(await getJob(h.forge.db, a.requestId)).toMatchObject({ status: 'completed', conclusion: 'failure', cancel_reason: 'runner-stopped' })
    expect(await getRun(h.forge.db, runId)).toMatchObject({ conclusion: 'failure' })
    expect(h.forge.checks.at(-1)).toMatchObject({ conclusion: 'failure', title: 'Runner lost: container stopped' })
    expect(await runnerStopped(h.forge.dispatch(h.server.url), jobId)).toBe(false)
    h.clock.offset = 30 * 60_000
    await reapActions(h.forge.dispatch(h.server.url))
    expect(h.launches).toHaveLength(1)
  })

  it('applies concurrency groups with cancel-in-progress', async () => {
    const h = await harness()
    const workflow = `on: push
concurrency:
  group: deploy-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  deploy:
    runs-on: self-hosted
    steps: [{ run: echo deploy }]
`
    await h.push({ '.github/workflows/deploy.yml': workflow })
    const runner = await h.runner(0)
    const first = await runner.take()
    await runner.renew(first)
    await h.push({ 'README.md': 'again\n' })
    const [one, two] = h.forge.runs
    expect(await jobs(h, two!.runId)).toEqual([['deploy', 'pending', null]])
    expect(await runner.poll()).toMatchObject({ messageType: 'JobCancellation' })
    await runner.finish(first, 'canceled')
    expect(await getRun(h.forge.db, one!.runId)).toMatchObject({ conclusion: 'cancelled' })
    expect(await jobs(h, two!.runId)).toEqual([['deploy', 'queued', null]])
  })

  it('runs one job per job-level concurrency group and replaces the waiting one', async () => {
    const h = await harness()
    const workflow = `on: push
jobs:
  deploy:
    runs-on: self-hosted
    concurrency: deploy-\${{ github.ref }}
    steps: [{ run: echo deploy }]
`
    await h.push({ '.github/workflows/deploy.yml': workflow })
    await h.push({ 'a.txt': 'a\n' })
    await h.push({ 'b.txt': 'b\n' })
    const [one, two, three] = h.forge.runs
    expect(await jobs(h, one!.runId)).toEqual([['deploy', 'queued', null]])
    expect(await jobs(h, two!.runId)).toEqual([['deploy', 'completed', 'cancelled']])
    expect(await jobs(h, three!.runId)).toEqual([['deploy', 'pending', null]])
    const runner = await h.runner(0)
    await runner.run()
    expect(await jobs(h, three!.runId)).toEqual([['deploy', 'queued', null]])
  })
})

describe('paths filters and variables', () => {
  it('skips pushes whose changed files are all ignored', async () => {
    const h = await harness()
    await h.push({ '.github/workflows/ci.yml': "on:\n  push:\n    paths-ignore: ['docs/**', '**.md']\njobs:\n  a:\n    runs-on: self-hosted\n    steps: [{ run: x }]\n" })
    await h.push({ 'docs/a.txt': 'a\n', 'README.md': 'r\n' })
    expect(h.forge.runs).toHaveLength(1)
    await h.push({ 'src/a.ts': 'a\n' })
    expect(h.forge.runs).toHaveLength(2)
  })

  it('serves repository and environment variables to trusted jobs', async () => {
    const h = await harness()
    expect((await h.api('/repos/acme/site/actions/variables', { method: 'POST', body: JSON.stringify({ name: 'stage', value: 'repo' }) })).status).toBe(201)
    expect((await h.api('/repos/acme/site/actions/variables', { method: 'POST', body: JSON.stringify({ name: 'STAGE', value: 'x' }) })).status).toBe(409)
    expect((await h.api('/repos/acme/site/actions/variables', { method: 'POST', body: JSON.stringify({ name: 'ENABLED', value: 'no' }) })).status).toBe(201)
    expect((await h.api('/repos/acme/site/actions/variables/enabled', { method: 'PATCH', body: JSON.stringify({ value: 'yes' }) })).status).toBe(204)
    expect(await (await h.api('/repos/acme/site/actions/variables/ENABLED')).json()).toMatchObject({ name: 'ENABLED', value: 'yes' })
    expect((await h.api('/repos/acme/site/actions/variables', { method: 'POST', token: REVIEWER_TOKEN, body: JSON.stringify({ name: 'X', value: 'x' }) })).status).toBe(404)
    await h.api('/repos/acme/site/environments/production', { method: 'PUT', body: JSON.stringify({}) })
    expect((await h.api('/repos/acme/site/environments/production/variables', { method: 'POST', body: JSON.stringify({ name: 'STAGE', value: 'production' }) })).status).toBe(201)
    await h.push({
      '.github/workflows/ci.yml': `on: push
jobs:
  deploy:
    if: vars.ENABLED == 'yes'
    runs-on: self-hosted
    environment: production
    steps: [{ run: echo }]
  off:
    if: vars.ENABLED != 'yes'
    runs-on: self-hosted
    steps: [{ run: echo }]
`,
    })
    expect(await jobs(h, h.forge.runs[0]!.runId)).toEqual([
      ['deploy', 'queued', null],
      ['off', 'completed', 'skipped'],
    ])
    const job = await (await h.runner(0)).take()
    expect(contextValue(job.message.contextData.vars, 'STAGE')).toBe('production')
    expect(contextValue(job.message.contextData.vars, 'ENABLED')).toBe('yes')
    expect((await h.api('/repos/acme/site/actions/variables/STAGE', { method: 'DELETE' })).status).toBe(204)
    expect(((await (await h.api('/repos/acme/site/actions/variables')).json()) as { total_count: number }).total_count).toBe(1)
  })
})

describe('secrets and environments', () => {
  it('stores secrets encrypted, gates environments on required reviewers and withholds secrets from untrusted runs', async () => {
    const key = await importSecretsKey(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))
    const h = await harness({ secretsKey: key, secrets: async () => ({ INSTANCE: 'from-instance' }) })
    expect(await (await h.api('/repos/acme/site/actions/secrets/DEPLOY_TOKEN', { method: 'PUT', body: JSON.stringify({ value: 'repo-secret-value' }) })).status).toBe(201)
    expect(await (await h.api('/repos/acme/site/actions/secrets/deploy_token', { method: 'PUT', body: JSON.stringify({ value: 'repo-secret-value' }) })).status).toBe(204)
    expect(await (await h.api('/repos/acme/site/actions/secrets/GITHUB_X', { method: 'PUT', body: JSON.stringify({ value: 'x' }) })).status).toBe(422)
    expect(await (await h.api('/repos/acme/site/actions/secrets/X', { method: 'PUT', body: JSON.stringify({ encrypted_value: 'x', key_id: '1' }) })).status).toBe(422)
    expect(await (await h.api('/repos/acme/site/actions/secrets/X', { method: 'PUT', token: REVIEWER_TOKEN, body: JSON.stringify({ value: 'x' }) })).status).toBe(404)
    const environment = (await (await h.api('/repos/acme/site/environments/production', { method: 'PUT', body: JSON.stringify({ reviewers: [{ type: 'User', login: 'reviewer' }] }) })).json()) as { id: number }
    expect(await (await h.api('/repos/acme/site/environments/production/secrets/ENV_ONLY', { method: 'PUT', body: JSON.stringify({ value: 'environment-secret-value' }) })).status).toBe(201)
    const listed = (await (await h.api('/repos/acme/site/actions/secrets')).json()) as { secrets: { name: string }[] }
    expect(listed.secrets.map((secret) => secret.name)).toEqual(['DEPLOY_TOKEN'])
    const stored = await h.forge.db.all<{ ciphertext: string }>({ sql: 'SELECT ciphertext FROM actions_secrets', params: [] })
    expect(stored.map((row) => row.ciphertext).join()).not.toMatch(/secret-value/)

    await h.push({
      '.github/workflows/deploy.yml': `on: push
jobs:
  deploy:
    runs-on: self-hosted
    environment: production
    steps:
      - run: echo "\${{ secrets.DEPLOY_TOKEN }} \${{ secrets.ENV_ONLY }}"
`,
    })
    const runId = h.forge.runs[0]!.runId
    expect(h.launches).toHaveLength(0)
    expect(await jobs(h, runId)).toEqual([['deploy', 'pending', null]])
    const pending = (await (await h.api(`/repos/acme/site/actions/runs/${runId}/pending_deployments`, { token: REVIEWER_TOKEN })).json()) as { current_user_can_approve: boolean }[]
    expect(pending).toMatchObject([{ environment: { name: 'production' }, current_user_can_approve: true }])
    const review = (token: string) =>
      h.api(`/repos/acme/site/actions/runs/${runId}/pending_deployments`, { method: 'POST', token, body: JSON.stringify({ environment_ids: [environment.id], state: 'approved', comment: 'ok' }) })
    expect(await (await review(ADMIN_TOKEN)).status).toBe(422)
    expect(await (await review(REVIEWER_TOKEN)).json()).toEqual([{ id: expect.any(Number), environment: 'production', state: 'approved', reviewed_by: 'reviewer' }])
    const job = await (await h.runner(0)).take()
    expect(job.message.variables).toMatchObject({
      DEPLOY_TOKEN: { value: 'repo-secret-value', isSecret: true },
      ENV_ONLY: { value: 'environment-secret-value', isSecret: true },
      INSTANCE: { value: 'from-instance', isSecret: true },
    })

    const [untrusted] = await queueRunsForPullRequest(h.forge.dispatch(h.server.url), {
      repo: { owner: 'acme', name: 'site' },
      number: 7,
      action: 'opened',
      actor: 'stranger',
      base: { ref: 'main', sha: (await getRun(h.forge.db, runId))!.sha },
      head: { ref: 'feature', sha: await h.push({ '.github/workflows/pr.yml': 'on: pull_request\njobs:\n  check:\n    runs-on: self-hosted\n    steps:\n      - run: echo "${{ secrets.DEPLOY_TOKEN }}"\n' }, 'feature'), repo: { owner: 'stranger', name: 'site' } },
      trusted: false,
    })
    expect(untrusted).toBeDefined()
    const launch = h.launches.find((candidate) => candidate.jobId === untrusted!.jobs[0]!.id)!
    const prJob = await (await FakeRunner.connect(h.server.url, SERVICE_PATH, launch.encodedJitConfig)).take()
    expect(Object.keys(prJob.message.variables).filter((name) => prJob.message.variables[name].isSecret)).toEqual(['system.github.token', 'github_token'])
    expect(contextValue(prJob.message.contextData.github, 'event_name')).toBe('pull_request')
    expect(contextValue(prJob.message.contextData.github, 'head_ref')).toBe('feature')
    expect(contextValue(prJob.message.contextData.github, 'ref')).toBe('refs/pull/7/head')
  })
})

describe('triggers', () => {
  it('dispatches workflows with validated inputs', async () => {
    const h = await harness()
    await h.push({
      '.github/workflows/manual.yml': `on:
  workflow_dispatch:
    inputs:
      level:
        type: choice
        options: [low, high]
        required: true
      dry:
        type: boolean
        default: true
jobs:
  go:
    runs-on: self-hosted
    if: inputs.level == 'high'
    steps:
      - run: echo \${{ inputs.level }}
`,
    })
    expect(h.forge.runs).toHaveLength(0)
    const dispatch = (body: unknown) => h.api('/repos/acme/site/actions/workflows/manual.yml/dispatches', { method: 'POST', body: JSON.stringify(body) })
    expect(await (await dispatch({ ref: 'main', inputs: { level: 'medium' } })).status).toBe(422)
    expect(await (await dispatch({ ref: 'nope', inputs: { level: 'high' } })).status).toBe(422)
    expect(await (await h.api('/repos/acme/site/actions/workflows/other.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) })).status).toBe(404)
    expect(await (await dispatch({ ref: 'main', inputs: { level: 'high' } })).status).toBe(204)
    const runs = (await (await h.api('/repos/acme/site/actions/runs')).json()) as { workflow_runs: { id: number; event: string; head_branch: string }[] }
    expect(runs.workflow_runs[0]).toMatchObject({ event: 'workflow_dispatch', head_branch: 'main' })
    const job = await (await h.runner(0)).take()
    expect(contextValue(job.message.contextData.inputs, 'level')).toBe('high')
    expect(contextValue(job.message.contextData.inputs, 'dry')).toBe(true)
    expect(contextValue(job.message.contextData.github, 'event', 'inputs', 'level')).toBe('high')
  })

  it('runs scheduled workflows from the default branch on the actions tick', async () => {
    const h = await harness()
    await h.push({
      '.github/workflows/nightly.yml': `on:
  schedule:
    - cron: '*/5 * * * *'
jobs:
  nightly:
    runs-on: self-hosted
    steps:
      - run: echo nightly
`,
    })
    await h.push({ 'other.txt': 'x\n' }, 'feature')
    const rows = await h.forge.db.all<{ cron: string; next_run_at: number }>({ sql: 'SELECT cron, next_run_at FROM actions_schedules', params: [] })
    expect(rows).toHaveLength(1)
    expect(h.forge.runs).toHaveLength(0)
    h.clock.offset = rows[0]!.next_run_at - Date.now() + 1000
    const tick = await actionsTick(h.forge.dispatch(h.server.url))
    expect(tick.scheduled).toHaveLength(1)
    expect((await actionsTick(h.forge.dispatch(h.server.url))).scheduled).toHaveLength(0)
    const run = await getRun(h.forge.db, tick.scheduled[0]!.runId)
    expect(run).toMatchObject({ event: 'schedule', ref: 'refs/heads/main', actor: 'schedule' })
    await h.push({ '.github/workflows/nightly.yml': 'on: workflow_dispatch\njobs:\n  a:\n    runs-on: x\n    steps: [{run: x}]\n' })
    expect(await h.forge.db.all({ sql: 'SELECT * FROM actions_schedules', params: [] })).toHaveLength(0)
  })
})

describe('uses: actions', () => {
  it('resolves actions to forge repositories, serves tarballs with a scoped token and reports unresolvable ones', async () => {
    const h = await harness({ actionSources: { repositories: { 'actions/*': 'mirrors/*' } } })
    await createRepository(h.forge.storage, { owner: 'mirrors', name: 'hello' })
    const action = initRepo()
    writeFile(action, 'action.yml', "name: hello\nruns:\n  using: node20\n  main: index.js\n")
    writeFile(action, 'index.js', "console.log('hello')\n")
    const actionSha = commitAll(action, 'action')
    await run('git', ['push', '-q', `${h.server.url.replace('://', `://admin:${ADMIN_TOKEN}@`)}/mirrors/hello.git`, 'main', 'main:refs/tags/v1'], { cwd: action, env: { ...process.env, ...gitEnv } })
    await h.push({
      '.github/workflows/ci.yml': `on: push
jobs:
  build:
    runs-on: self-hosted
    steps:
      - uses: actions/hello@v1
        with:
          who: world
`,
    })
    const job = await (await h.runner(0)).take()
    expect(job.message.steps[0].reference).toEqual({ type: 'repository', repositoryType: 'GitHub', name: 'actions/hello', ref: 'v1', path: '' })
    const info = (actions: unknown) =>
      fetch(`${job.planPath('ActionDownloadInfo')}`, { method: 'POST', headers: { Authorization: `Bearer ${job.runtimeToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ actions }) })
    const response = await info([{ nameWithOwner: 'actions/hello', ref: 'v1' }])
    expect(response.status).toBe(200)
    const resolved = ((await response.json()) as { actions: Record<string, { tarballUrl: string; resolvedSha: string; resolvedNameWithOwner: string; authentication: { token: string } }> }).actions['actions/hello@v1']!
    expect(resolved).toMatchObject({ resolvedSha: actionSha, resolvedNameWithOwner: 'mirrors/hello', tarballUrl: `${h.server.url}/api/v3/repos/mirrors/hello/tarball/${actionSha}` })
    expect((await fetch(resolved.tarballUrl)).status).toBe(404)
    const tarball = await fetch(resolved.tarballUrl, { headers: { Authorization: `Basic ${btoa(`x-access-token:${resolved.authentication.token}`)}` } })
    expect(tarball.status).toBe(200)
    const expected = await readAll(
      commitTarball(new ObjectDatabase(h.forge.storage, { owner: 'mirrors', name: 'hello' }), actionSha, { prefix: `mirrors-hello-${actionSha.slice(0, 7)}` }).pipeThrough(
        new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
      ),
    )
    const actual = new Uint8Array(await tarball.arrayBuffer())
    const inflate = async (bytes: Uint8Array) => readAll(new Response(bytes as Uint8Array<ArrayBuffer>).body!.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>))
    expect(await inflate(actual)).toEqual(await inflate(expected))
    expect((await fetch(`${h.server.url}/api/v3/repos/acme/site/tarball/main`, { headers: { Authorization: `Basic ${btoa(`x-access-token:${resolved.authentication.token}`)}` } })).status).toBe(404)
    const missing = await info([{ nameWithOwner: 'actions/missing', ref: 'v1' }])
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { message: string }).message).toContain('actions/missing@v1')
  })

  it('serves private actions of the same owner only to trusted runs after the action repository opted in, with an archive-only token', async () => {
    const h = await harness()
    await createRepository(h.forge.storage, { owner: 'acme', name: 'tool' })
    const action = initRepo()
    writeFile(action, 'action.yml', 'name: tool\nruns:\n  using: node20\n  main: index.js\n')
    const actionSha = commitAll(action, 'action')
    await run('git', ['push', '-q', `${h.server.url.replace('://', `://admin:${ADMIN_TOKEN}@`)}/acme/tool.git`, 'main'], { cwd: action, env: { ...process.env, ...gitEnv } })
    await h.push({ '.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: acme/tool@main\n' })
    const job = await (await h.runner(0)).take()
    const info = () =>
      fetch(job.planPath('ActionDownloadInfo'), { method: 'POST', headers: { Authorization: `Bearer ${job.runtimeToken}` }, body: JSON.stringify({ actions: [{ nameWithOwner: 'acme/tool', ref: 'main' }] }) })
    const access = (level?: string) => h.api('/repos/acme/tool/actions/permissions/access', level ? { method: 'PUT', body: JSON.stringify({ access_level: level }) } : {})
    expect(await (await access()).json()).toEqual({ access_level: 'none' })
    expect((await info()).status).toBe(404)
    expect((await access('everyone')).status).toBe(422)
    expect((await access('organization')).status).toBe(204)
    expect(await (await access()).json()).toEqual({ access_level: 'organization' })
    const response = await info()
    expect(response.status).toBe(200)
    const { token } = ((await response.json()) as { actions: Record<string, { authentication: { token: string } }> }).actions['acme/tool@main']!.authentication
    const basic = { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` }
    expect((await fetch(`${h.server.url}/api/v3/repos/acme/tool/tarball/${actionSha}`, { headers: basic })).status).toBe(200)
    expect((await fetch(`${h.server.url}/api/v3/repos/acme/tool/tarball/main`, { headers: basic })).status).toBe(404)
    expect((await fetch(`${h.server.url}/acme/tool.git/info/refs?service=git-upload-pack`, { headers: basic })).status).toBe(401)
    await expect(run('git', ['clone', '-q', `${h.server.url.replace('://', `://x-access-token:${token}@`)}/acme/tool.git`, initRepo() + '/clone'], { env: { ...process.env, ...gitEnv } })).rejects.toThrow()
    await h.forge.db.run({ sql: 'UPDATE actions_runs SET trusted = 0', params: [] })
    expect((await info()).status).toBe(404)
  })

  it('falls back to github.com tarballs when configured', async () => {
    const h = await harness({ actionSources: { githubFallback: 'https://api.github.com' } })
    await h.push({ '.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n' })
    const job = await (await h.runner(0)).take()
    const response = await fetch(job.planPath('ActionDownloadInfo'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${job.runtimeToken}` },
      body: JSON.stringify({ actions: [{ nameWithOwner: 'actions/checkout', ref: 'v4' }] }),
    })
    expect(((await response.json()) as { actions: Record<string, unknown> }).actions['actions/checkout@v4']).toMatchObject({
      tarballUrl: 'https://api.github.com/repos/actions/checkout/tarball/v4',
      authentication: null,
    })
  })
})
