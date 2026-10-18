import { decodeConfig, exchangeToken } from '@git-forge/actions/test/runner-client.ts'
import { writeFileSync, mkdirSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateHistory, git, gitFails, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const ADMIN_TOKEN = `e2e-${crypto.randomUUID()}`

let dev: WranglerDev
let source: string
let remote: string
let pushRemote: string

const admin = (body: unknown, token = ADMIN_TOKEN) =>
  fetch(`${dev.url}/api/admin/repos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const log = (dir: string, ref = 'HEAD') => git(dir, ['log', '--format=%H %s', ref])

const requestsSince = (mark: number) =>
  dev
    .output()
    .slice(mark)
    .split('\n')
    .filter((line) => /\b(GET|POST|HEAD) \//.test(line))

beforeAll(async () => {
  dev = await startWranglerDev({ ADMIN_TOKEN })
  source = tempDir()
  await git(source, ['init', '-q', '-b', 'main'])
  generateHistory(source, { commits: 120, files: 40, binaryBytes: 48 * 1024, seed: 1 })
  remote = `${dev.url}/e2e/history.git`
  pushRemote = remote.replace('http://', `http://git:${ADMIN_TOKEN}@`)
}, 90_000)

afterAll(async () => {
  await dev?.stop()
})

describe('forge worker on wrangler dev', () => {
  it('protects the admin endpoint and creates a repository', async () => {
    expect((await admin({ owner: 'e2e', name: 'history' }, 'wrong')).status).toBe(401)
    expect((await admin({ owner: 'e2e', name: 'bad.git' })).status).toBe(400)
    const created = await admin({ owner: 'e2e', name: 'history' })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ owner: 'e2e', name: 'history', defaultBranch: 'main', cloneUrl: `${dev.url}/e2e/history.git` })
    expect((await admin({ owner: 'e2e', name: 'history' })).status).toBe(409)
  })

  it('rejects pushes without the token', async () => {
    const message = await gitFails(source, ['push', remote, 'main'])
    expect(message).toMatch(/401|Authentication failed|could not read Username/i)
  })

  it('accepts a push of a generated history with the real git client', async () => {
    const started = performance.now()
    await git(source, ['push', pushRemote, 'main'])
    console.log(`push of 120 commits took ${Math.round(performance.now() - started)} ms wall time`)
    expect(await git(source, ['ls-remote', remote])).toContain('refs/heads/main')
  })

  it('clones with protocol v2', async () => {
    const mark = dev.output().length
    const target = tempDir()
    await git(target, ['-c', 'protocol.version=2', 'clone', '-q', remote, 'out'])
    expect(await log(`${target}/out`)).toBe(await log(source))
    expect(await git(`${target}/out`, ['fsck', '--full', '--strict'])).toBe('')
    expect(requestsSince(mark).some((line) => line.includes('/git-upload-pack'))).toBe(true)
  })

  it('clones over dumb HTTP with protocol v0', async () => {
    const mark = dev.output().length
    const target = tempDir()
    await git(target, ['-c', 'protocol.version=0', 'clone', '-q', remote, 'out'])
    expect(await log(`${target}/out`)).toBe(await log(source))
    expect(await git(`${target}/out`, ['fsck', '--full', '--strict'])).toBe('')
    const requests = requestsSince(mark)
    expect(requests.some((line) => /\/objects\/pack\/pack-[0-9a-f]{40}\.pack/.test(line))).toBe(true)
    expect(requests.some((line) => line.includes('/git-upload-pack'))).toBe(false)
  })

  it('accepts an incremental push and serves it to an existing clone', async () => {
    const target = tempDir()
    await git(target, ['clone', '-q', remote, 'out'])
    generateHistory(source, { commits: 15, files: 40, binaryBytes: 8 * 1024, seed: 2, from: 'refs/heads/main^0' })
    await git(source, ['push', pushRemote, 'main'])
    await git(`${target}/out`, ['pull', '-q', '--ff-only'])
    expect(await log(`${target}/out`)).toBe(await log(source))
    const dumb = tempDir()
    await git(dumb, ['-c', 'protocol.version=0', 'clone', '-q', remote, 'out'])
    expect(await log(`${dumb}/out`)).toBe(await log(source))
  })

  it('archives the previous tip under refs/archive/ on a force push', async () => {
    const previous = (await git(source, ['rev-parse', 'main'])).trim()
    const base = (await git(source, ['rev-parse', 'main~20'])).trim()
    await git(source, ['update-ref', 'refs/heads/main', base])
    generateHistory(source, { commits: 3, files: 40, binaryBytes: 1024, seed: 3, from: base })
    const rewritten = (await git(source, ['rev-parse', 'main'])).trim()
    expect(await gitFails(source, ['push', pushRemote, 'main'])).toMatch(/rejected|non-fast-forward|fetch first/)
    await git(source, ['push', '--force', pushRemote, 'main'])
    const refs = await git(source, ['ls-remote', remote])
    expect(refs).toContain(`${rewritten}\trefs/heads/main`)
    const archived = refs.split('\n').find((line) => line.startsWith(previous) && line.includes('\trefs/archive/'))
    expect(archived).toMatch(/\trefs\/archive\/\d{4}-\d{2}-\d{2}T[\d-]+Z\/heads\/main$/)
    const target = tempDir()
    await git(target, ['clone', '-q', remote, 'out'])
    expect((await git(`${target}/out`, ['rev-parse', 'HEAD'])).trim()).toBe(rewritten)
    await git(`${target}/out`, ['fetch', '-q', 'origin', archived!.split('\t')[1]!])
    expect((await git(`${target}/out`, ['rev-parse', 'FETCH_HEAD'])).trim()).toBe(previous)
    expect(await gitFails(source, ['push', pushRemote, `${rewritten}:${archived!.split('\t')[1]!}`])).toMatch(/invalid ref name|rejected/)
  })

  it('runs the scheduled handler stub', async () => {
    const response = await fetch(`${dev.url}/__scheduled?cron=${encodeURIComponent('*/30 * * * *')}`)
    expect(response.status).toBe(200)
    await expect.poll(() => dev.output()).toContain('"task":"mirror-sync"')
  })

  it('queues a workflow run on push and hands the job to a JIT runner over the Actions protocol', async () => {
    const api = (path: string, init: RequestInit = {}, token = ADMIN_TOKEN) =>
      fetch(`${dev.url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } })
    expect((await admin({ owner: 'e2e', name: 'ci' })).status).toBe(201)
    const repo = tempDir()
    await git(repo, ['init', '-q', '-b', 'main'])
    mkdirSync(`${repo}/.github/workflows`, { recursive: true })
    writeFileSync(`${repo}/.github/workflows/ci.yml`, 'on: push\njobs:\n  hello:\n    runs-on: [self-hosted, e2e]\n    steps:\n      - run: echo hello\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'workflow'])
    await git(repo, ['push', '-q', `${dev.url.replace('http://', `http://git:${ADMIN_TOKEN}@`)}/e2e/ci.git`, 'main'])
    const runs = (await (await api('/api/v3/repos/e2e/ci/actions/runs')).json()) as { workflow_runs: { id: number; status: string }[] }
    expect(runs.workflow_runs).toHaveLength(1)
    expect(runs.workflow_runs[0]!.status).toBe('queued')
    expect((await api('/api/v3/repos/e2e/ci/actions/runs', {}, 'wrong')).status).toBe(404)

    const generated = await api('/api/v3/repos/e2e/ci/actions/runners/generate-jitconfig', { method: 'POST', body: JSON.stringify({ name: 'e2e-runner', runner_group_id: 1, labels: ['self-hosted', 'e2e'] }) })
    expect(generated.status).toBe(201)
    const config = decodeConfig(((await generated.json()) as { encoded_jit_config: string }).encoded_jit_config)
    expect(config['.runner']['ServerUrl']).toBe(`${dev.url}/_services/actions`)
    const token = ((await (await exchangeToken(config)).json()) as { access_token: string }).access_token
    const services = `${dev.url}/_services/actions/_apis`
    expect((await fetch(`${services}/connectionData?connectOptions=1`)).status).toBe(200)
    const session = (await (await api('/_services/actions/_apis/v1/AgentSession/1', { method: 'POST', body: JSON.stringify({ ownerName: 'e2e', agent: { id: config['.runner']['AgentId'] } }) }, token)).json()) as {
      sessionId: string
    }
    const message = await api(`/_services/actions/_apis/v1/Message/1?sessionId=${session.sessionId}`, {}, token)
    expect(message.status).toBe(200)
    const job = JSON.parse(((await message.json()) as { body: string }).body) as { jobName: string; requestId: number }
    expect(job.jobName).toBe('hello')
    const renewed = await api(`/_services/actions/_apis/v1/AgentRequest/1/${job.requestId}`, { method: 'PATCH', body: JSON.stringify({ requestId: job.requestId }) }, token)
    expect(renewed.status).toBe(200)
    const jobs = (await (await api(`/api/v3/repos/e2e/ci/actions/runs/${runs.workflow_runs[0]!.id}/jobs`)).json()) as { jobs: { status: string }[] }
    expect(jobs.jobs[0]!.status).toBe('in_progress')
  })
})
