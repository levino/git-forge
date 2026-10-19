import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { copyRunner, downloadRunner, runnerEnv } from '@git-forge/actions/test/runner-download.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const run = promisify(execFile)
const BOOTSTRAP_TOKEN = `e2e-${crypto.randomUUID()}`
const HOOK_SECRET = 'provider-secret'
const runner = await downloadRunner()

type Delivery = { readonly action: string; readonly name: string; readonly labels: string[]; readonly valid: boolean }

let dev: WranglerDev
let admin = ''
let proxyUrl = ''
const servers: Server[] = []
const children: ChildProcess[] = []
const deliveries: Delivery[] = []
const output: string[] = []

const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`${dev.url}${path}`, { ...init, headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' } })
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : ((await response.json()) as any)
}

const body = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((done) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => done(Buffer.concat(chunks)))
  })

const listen = async (handler: (request: IncomingMessage, payload: Buffer) => Promise<{ status: number; headers?: Record<string, string>; body: Uint8Array | string }>): Promise<string> => {
  const server = createServer(async (request, response) => {
    const answer = await handler(request, await body(request)).catch((error: unknown) => ({ status: 502, headers: {}, body: String(error) }))
    response.writeHead(answer.status, answer.headers)
    response.end(answer.body)
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const startRunner = async (args: string[]): Promise<void> => {
  const home = await copyRunner((runner as { dir: string }).dir)
  const child = spawn(join(home, 'run.sh'), args, { cwd: home, env: { ...runnerEnv(home), http_proxy: proxyUrl } })
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  children.push(child)
}

const provider = async (request: IncomingMessage, payload: Buffer) => {
  const event = JSON.parse(payload.toString('utf8')) as { action: string; workflow_job: { id: number; name: string; labels: string[] } }
  const valid = request.headers['x-hub-signature-256'] === `sha256=${createHmac('sha256', HOOK_SECRET).update(payload).digest('hex')}`
  if (request.headers['x-github-event'] === 'workflow_job') {
    deliveries.push({ action: event.action, name: event.workflow_job.name, labels: event.workflow_job.labels, valid })
    if (valid && event.action === 'queued' && event.workflow_job.labels.includes('mini-provider')) {
      const generated = await call('/api/v3/orgs/acme/actions/runners/generate-jitconfig', {
        method: 'POST',
        body: JSON.stringify({ name: `mini-${event.workflow_job.id}`, runner_group_id: 1, labels: event.workflow_job.labels }),
      })
      await startRunner(['--jitconfig', generated.encoded_jit_config])
    }
  }
  return { status: 200, body: '{}' }
}

const proxy = async (request: IncomingMessage, payload: Buffer) => {
  const target = new URL(request.url ?? '/')
  const headers = Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !['host', 'connection', 'proxy-connection', 'keep-alive', 'expect', 'transfer-encoding', 'content-length'].includes(entry[0])))
  const response = await fetch(`${dev.url}${target.pathname}${target.search}`, { method: request.method ?? 'GET', headers, ...(payload.length > 0 ? { body: new Uint8Array(payload) } : {}) })
  const passed = Object.fromEntries([...response.headers].filter(([name]) => !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)))
  return { status: response.status, headers: passed, body: new Uint8Array(await response.arrayBuffer()) }
}

beforeAll(async () => {
  if ('skip' in runner) return
  proxyUrl = await listen(proxy)
  dev = await startWranglerDev({ vars: { BOOTSTRAP_TOKEN, PUBLIC_URL: 'http://forge.test', ALLOW_INSECURE_WEBHOOKS: 'true', ACTIONS_RUNNER_LABELS: 'cloudflare' } })
  admin = (await (await fetch(`${dev.url}/api/bootstrap`, { method: 'POST', headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}` }, body: JSON.stringify({ login: 'e2e' }) })).json()).token
}, 120_000)

afterAll(async () => {
  for (const child of children) child.kill('SIGINT')
  for (const server of servers) server.close()
  await dev?.stop()
})

describe.skipIf('skip' in runner)(`self-hosted runners and providers on wrangler dev${'skip' in runner ? ` (skipped: ${runner.skip})` : ''}`, () => {
  it('runs one job on a runner registered with config.sh and one on a JIT runner started by a provider from a workflow_job webhook', { timeout: 300_000 }, async () => {
    await call('/api/orgs', { method: 'POST', body: JSON.stringify({ login: 'acme' }) })
    await call('/api/repos', { method: 'POST', body: JSON.stringify({ owner: 'acme', name: 'ci' }) })
    await call('/api/v3/orgs/acme/hooks', { method: 'POST', body: JSON.stringify({ name: 'web', config: { url: `${await listen(provider)}/hook`, content_type: 'json', secret: HOOK_SECRET }, events: ['workflow_job'] }) })
    const { token } = await call('/api/v3/repos/acme/ci/actions/runners/registration-token', { method: 'POST' })
    const home = await copyRunner((runner as { dir: string }).dir)
    await run(join(home, 'config.sh'), ['--unattended', '--url', 'http://forge.test/acme/ci', '--token', token, '--name', 'laptop', '--labels', 'laptop', '--work', '_work', '--disableupdate'], {
      cwd: home,
      env: { ...runnerEnv(home), http_proxy: proxyUrl },
    }).catch((error: { stdout?: string; stderr?: string }) => {
      throw new Error(`config.sh failed:\n${error.stdout}\n${error.stderr}`)
    })
    const registered = await call('/api/v3/repos/acme/ci/actions/runners?name=laptop')
    expect(registered.runners.map((entry: { labels: { name: string }[] }) => entry.labels.map((label) => label.name))).toEqual([['self-hosted', 'Linux', 'X64', 'laptop']])
    const child = spawn(join(home, 'run.sh'), [], { cwd: home, env: { ...runnerEnv(home), http_proxy: proxyUrl } })
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()))
    children.push(child)

    const repo = tempDir()
    await git(repo, ['init', '-q', '-b', 'main'])
    mkdirSync(`${repo}/.github/workflows`, { recursive: true })
    writeFileSync(
      `${repo}/.github/workflows/ci.yml`,
      'on: push\njobs:\n  local:\n    runs-on: [self-hosted, laptop]\n    steps:\n      - run: echo "hello from the laptop"\n  provided:\n    runs-on: [self-hosted, mini-provider]\n    steps:\n      - run: echo "hello from the provider"\n',
    )
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'ci'])
    await git(repo, ['push', '-q', `${dev.url.replace('http://', `http://git:${admin}@`)}/acme/ci.git`, 'main'])

    const deadline = Date.now() + 240_000
    let jobs: { name: string; status: string; conclusion: string | null; runner_id: number | null }[] = []
    while (Date.now() < deadline) {
      const [latest] = (await call('/api/v3/repos/acme/ci/actions/runs')).workflow_runs as { id: number }[]
      jobs = latest ? (await call(`/api/v3/repos/acme/ci/actions/runs/${latest.id}/jobs`)).jobs : []
      if (jobs.length === 2 && jobs.every((job) => job.status === 'completed') && deliveries.filter((entry) => entry.action === 'completed').length === 2) break
      await new Promise((done) => setTimeout(done, 1000))
    }
    const details = `runner output:\n${output.join('').slice(-6000)}\nwrangler:\n${dev.output().slice(-4000)}`
    expect(jobs.map((job) => [job.name, job.conclusion]).sort(), details).toEqual([
      ['local', 'success'],
      ['provided', 'success'],
    ])
    expect(jobs.find((job) => job.name === 'local')!.runner_id, details).toBe(registered.runners[0].id)
    expect(deliveries.every((entry) => entry.valid)).toBe(true)
    expect(
      deliveries.filter((entry) => entry.name === 'provided').map((entry) => entry.action),
      details,
    ).toEqual(['queued', 'in_progress', 'completed'])
    expect(deliveries.find((entry) => entry.name === 'provided')!.labels).toEqual(['self-hosted', 'mini-provider'])
    for (let i = 0; i < 30 && (await call('/api/v3/orgs/acme/actions/runners')).total_count > 0; i++) await new Promise((done) => setTimeout(done, 1000))
    expect((await call('/api/v3/orgs/acme/actions/runners')).total_count, details).toBe(0)
  })
})
