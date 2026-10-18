import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { configureMirror, createRepository, syncMirror } from '@git-forge/core'
import { commitAll, gitEnv, initRepo, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getJob, getRun, importSecretsKey, type JobRow, listCurrentJobs, listTimelineRecords, type RunnerLaunch } from '../src/index.ts'
import { ADMIN_TOKEN, createTestForge, type TestForge } from './forge.ts'

const run = promisify(execFile)

const RUNNER_ARCH: Partial<Record<string, string>> = { x64: 'x64', arm64: 'arm64' }

const FALLBACK_RUNNER_VERSION = '2.329.0'

const CHECKOUT_TAG = 'v4'

const wrangler = fileURLToPath(new URL('../../../apps/forge-worker/node_modules/.bin/wrangler', import.meta.url))

const latestRunnerVersion = async (): Promise<string> => {
  try {
    const release = await fetch('https://api.github.com/repos/actions/runner/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    if (release.ok) return ((await release.json()) as { tag_name: string }).tag_name.replace(/^v/, '')
  } catch {}
  return FALLBACK_RUNNER_VERSION
}

const downloadRunner = async (): Promise<{ dir: string } | { skip: string }> => {
  if (process.env['ACTIONS_RUNNER_DIR']) return { dir: process.env['ACTIONS_RUNNER_DIR'] }
  const arch = RUNNER_ARCH[process.arch]
  if (process.platform !== 'linux' || !arch) return { skip: `no actions/runner build for ${process.platform}-${process.arch} in this test` }
  try {
    const version = await latestRunnerVersion()
    const dir = join(tmpdir(), 'git-forge-actions-runner', version)
    if (existsSync(join(dir, 'run.sh'))) return { dir }
    const asset = await fetch(`https://github.com/actions/runner/releases/download/v${version}/actions-runner-linux-${arch}-${version}.tar.gz`)
    if (!asset.ok) return { skip: `cannot download actions/runner ${version} (HTTP ${asset.status})` }
    mkdirSync(dir, { recursive: true })
    const archive = join(dir, 'runner.tar.gz')
    writeFileSync(archive, new Uint8Array(await asset.arrayBuffer()))
    await run('tar', ['-xzf', archive, '-C', dir])
    return { dir }
  } catch (error) {
    return { skip: `cannot download actions/runner: ${(error as Error).message}` }
  }
}

const runner = await downloadRunner()

const RUN_DEADLINE_MS = 180_000

const MASKED_SECRET = 'correct-horse-battery-staple'

const children = new Map<string, ChildProcess>()
const output: string[] = []
const launches: RunnerLaunch[] = []
let forge: TestForge
let server: RunningServer
let repoCounter = 0

const copyRunner = async (from: string): Promise<string> => {
  const home = tempDir('git-forge-runner-')
  try {
    await run('cp', ['-al', `${from}/.`, home])
  } catch {
    await run('cp', ['-a', `${from}/.`, home])
  }
  return home
}

const launch = async (request: RunnerLaunch) => {
  launches.push(request)
  const home = await copyRunner((runner as { dir: string }).dir)
  const child = spawn(join(home, 'run.sh'), ['--jitconfig', request.encodedJitConfig], {
    cwd: home,
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: home,
      LANG: 'C.UTF-8',
      ...(process.env['HTTPS_PROXY'] ? { HTTPS_PROXY: process.env['HTTPS_PROXY'], NO_PROXY: '127.0.0.1,localhost' } : {}),
      RUNNER_ALLOW_RUNASROOT: '1',
      DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
      GITHUB_ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT: '1',
      WRANGLER: wrangler,
    },
  })
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  children.set(request.jobId, child)
}

const alive = (child: ChildProcess | undefined): boolean => child !== undefined && child.exitCode === null && child.signalCode === null

const pushRepository = async (files: Record<string, string>): Promise<{ owner: string; name: string; sha: string }> => {
  const repo = { owner: 'acme', name: `site${++repoCounter}` }
  await createRepository(forge.storage, repo)
  const source = initRepo()
  for (const [path, content] of Object.entries(files)) writeFile(source, path, content)
  const sha = commitAll(source, 'workflow')
  await run('git', ['push', '-q', `${server.url.replace('://', `://admin:${ADMIN_TOKEN}@`)}/${repo.owner}/${repo.name}.git`, 'main'], { cwd: source, env: { ...process.env, ...gitEnv } })
  return { ...repo, sha }
}

const runIdFor = async (repo: { name: string }): Promise<number> => {
  for (const queued of forge.runs) if ((await getRun(forge.db, queued.runId))?.repo === repo.name) return queued.runId
  throw new Error(`no run for ${repo.name}`)
}

const logsOf = async (owner: string, name: string, job: JobRow): Promise<string> =>
  (await fetch(`${server.url}/api/v3/repos/${owner}/${name}/actions/jobs/${job.request_id}/logs`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).text()

const diagnostics = async (owner: string, name: string, runId: number): Promise<string> => {
  const jobs = await listCurrentJobs(forge.db, runId)
  const logs = await Promise.all(jobs.map(async (job) => `--- ${job.display_name} (${job.status}/${job.conclusion})\n${(await logsOf(owner, name, job)).slice(-8_000)}`))
  const requests = server.requests.map((request) => `${request.status} ${request.method} ${request.path}`).join('\n')
  return `runner output:\n${output.join('').slice(-15_000)}\nforge requests:\n${requests.slice(-8_000)}\njob logs:\n${logs.join('\n')}`
}

const waitFor = async (condition: () => Promise<boolean>, deadline = Date.now() + RUN_DEADLINE_MS): Promise<boolean> => {
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

const waitForRun = async (runId: number): Promise<void> => {
  await waitFor(async () => (await getRun(forge.db, runId))?.completed_at !== null || ![...children.values()].some(alive))
  await waitFor(async () => (await getRun(forge.db, runId))?.completed_at !== null, Date.now() + 15_000)
}

afterAll(async () => {
  for (const child of children.values()) child.kill('SIGINT')
  await server?.close()
})

describe.skipIf('skip' in runner)(`official actions/runner${'skip' in runner ? ` (skipped: ${runner.skip})` : ''}`, () => {
  beforeAll(async () => {
    const secretsKey = await importSecretsKey(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))
    forge = await createTestForge({
      launcher: { launch },
      secretsKey,
      secrets: async () => (process.env['CLOUDFLARE_API_TOKEN'] ? { CLOUDFLARE_API_TOKEN: process.env['CLOUDFLARE_API_TOKEN'] } : {}),
      actionSources: { repositories: { 'actions/*': 'actions/*' } },
    })
    server = await startServer(forge.handler)
    const checkout = { owner: 'actions', name: 'checkout' }
    await createRepository(forge.storage, checkout)
    await configureMirror(forge.storage, checkout, { url: 'https://github.com/actions/checkout.git', lfs: false })
    const synced = await syncMirror({ storage: forge.storage, repo: checkout, strategy: 'fetch' })
    expect(synced.status, synced.error).toBe('ok')
  }, 120_000)

  it('checks out with actions/checkout from a mirror on the forge and runs a wrangler deploy', { timeout: 240_000 }, async () => {
    const repo = await pushRepository({
      '.github/workflows/deploy.yml': `name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: [self-hosted, linux]
    steps:
      - name: Checkout
        uses: actions/checkout@${CHECKOUT_TAG}
      - run: test -f src/index.js && git log -1 --format=%H && echo "hello from \${{ github.repository }} at \${{ github.sha }}"
      - name: Deploy with wrangler
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: |
          if [ -n "$CLOUDFLARE_API_TOKEN" ]; then
            "$WRANGLER" deploy
          else
            echo "no CLOUDFLARE_API_TOKEN, running wrangler deploy --dry-run"
            "$WRANGLER" deploy --dry-run --outdir dist
            test -f dist/index.js
          fi
`,
      'src/index.js': "export default { fetch: () => new Response('hello from the forge') }\n",
      'wrangler.toml': 'name = "forge-hello"\nmain = "src/index.js"\ncompatibility_date = "2026-10-01"\n',
    })
    const runId = await runIdFor(repo)
    await waitForRun(runId)
    const [job] = await listCurrentJobs(forge.db, runId)
    const details = await diagnostics(repo.owner, repo.name, runId)
    expect(job, details).toMatchObject({ status: 'completed', conclusion: 'success' })
    const logs = await logsOf(repo.owner, repo.name, job!)
    expect(logs, details).toContain(`Download action repository 'actions/checkout@${CHECKOUT_TAG}'`)
    expect(logs, details).toContain(`hello from ${repo.owner}/${repo.name} at ${repo.sha}`)
    expect(logs, details).toMatch(/wrangler deploy --dry-run|Uploaded forge-hello/)
    const records = await listTimelineRecords(forge.db, job!.timeline_id)
    expect(records.map((record) => record['name'])).toEqual(expect.arrayContaining(['Checkout', 'Deploy with wrangler']))
  })

  it('runs a matrix, passes job outputs through needs and masks secrets', { timeout: 240_000 }, async () => {
    const repo = await pushRepository({
      '.github/workflows/matrix.yml': `on: push
jobs:
  build:
    runs-on: self-hosted
    strategy:
      matrix:
        n: [1, 2]
    outputs:
      value: \${{ steps.out.outputs.value }}
    steps:
      - id: out
        run: echo "value=from-\${{ matrix.n }}" >> "$GITHUB_OUTPUT"
      - run: echo "the secret is \${{ secrets.MASKED }}"
  check:
    needs: build
    runs-on: self-hosted
    steps:
      - run: |
          test "\${{ needs.build.result }}" = success
          echo "build said \${{ needs.build.outputs.value }}"
`,
    })
    expect(await (await fetch(`${server.url}/api/v3/repos/${repo.owner}/${repo.name}/actions/secrets/MASKED`, { method: 'PUT', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, body: JSON.stringify({ value: MASKED_SECRET }) })).status).toBe(201)
    const runId = await runIdFor(repo)
    await waitForRun(runId)
    const details = await diagnostics(repo.owner, repo.name, runId)
    const jobs = await listCurrentJobs(forge.db, runId)
    expect(
      jobs.map((job) => [job.display_name, job.conclusion]),
      details,
    ).toEqual([
      ['build (1)', 'success'],
      ['check', 'success'],
      ['build (2)', 'success'],
    ])
    expect(jobs[0]!.outputs, details).toMatch(/from-[12]/)
    const build = await logsOf(repo.owner, repo.name, jobs[0]!)
    expect(build, details).toContain('the secret is ***')
    expect(build, details).not.toContain(MASKED_SECRET)
    expect(await logsOf(repo.owner, repo.name, jobs[1]!), details).toMatch(/build said from-[12]/)
  })

  it('cancels a running job on the real runner', { timeout: 240_000 }, async () => {
    const repo = await pushRepository({
      '.github/workflows/slow.yml': `on: push
jobs:
  slow:
    runs-on: self-hosted
    steps:
      - run: echo started && sleep 600
`,
    })
    const runId = await runIdFor(repo)
    const [queued] = await listCurrentJobs(forge.db, runId)
    const started = await waitFor(async () => (await getJob(forge.db, queued!.request_id))?.status === 'in_progress', Date.now() + 120_000)
    expect(started, await diagnostics(repo.owner, repo.name, runId)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const cancel = await fetch(`${server.url}/api/v3/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })
    expect(cancel.status).toBe(202)
    await waitFor(async () => (await getRun(forge.db, runId))?.completed_at !== null, Date.now() + 90_000)
    const details = await diagnostics(repo.owner, repo.name, runId)
    expect(await getJob(forge.db, queued!.request_id), details).toMatchObject({ status: 'completed', conclusion: 'cancelled' })
    expect(await getRun(forge.db, runId), details).toMatchObject({ conclusion: 'cancelled' })
    expect(await waitFor(async () => !alive(children.get(queued!.id)), Date.now() + 60_000), details).toBe(true)
  })
})
