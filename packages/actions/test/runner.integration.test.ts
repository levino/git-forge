import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createRepository } from '@git-forge/core'
import { commitAll, gitEnv, initRepo, tempDir, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { type RunningServer, startServer } from '@git-forge/core/test/http-server.ts'
import { afterAll, describe, expect, it } from 'vitest'
import { getJob, listTimelineRecords, type RunnerLaunch } from '../src/index.ts'
import { ADMIN_TOKEN, createTestForge } from './forge.ts'

const run = promisify(execFile)

const RUNNER_ARCH: Partial<Record<string, string>> = { x64: 'x64', arm64: 'arm64' }

const wrangler = fileURLToPath(new URL('../../../apps/forge-worker/node_modules/.bin/wrangler', import.meta.url))

const downloadRunner = async (): Promise<{ dir: string } | { skip: string }> => {
  if (process.env['ACTIONS_RUNNER_DIR']) return { dir: process.env['ACTIONS_RUNNER_DIR'] }
  const arch = RUNNER_ARCH[process.arch]
  if (process.platform !== 'linux' || !arch) return { skip: `no actions/runner build for ${process.platform}-${process.arch} in this test` }
  try {
    const release = await fetch('https://api.github.com/repos/actions/runner/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    if (!release.ok) return { skip: `cannot query the latest actions/runner release (HTTP ${release.status})` }
    const { tag_name: tag } = (await release.json()) as { tag_name: string }
    const version = tag.replace(/^v/, '')
    const dir = join(tmpdir(), 'git-forge-actions-runner', version)
    if (existsSync(join(dir, 'run.sh'))) return { dir }
    const asset = await fetch(`https://github.com/actions/runner/releases/download/${tag}/actions-runner-linux-${arch}-${version}.tar.gz`)
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

const WORKFLOW = `name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: [self-hosted, linux]
    steps:
      - name: Checkout from the forge
        env:
          TOKEN: \${{ github.token }}
        run: |
          auth=$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\\n')
          git -c http.extraHeader="Authorization: Basic $auth" clone -q "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git" site
          test -f site/src/index.js
      - run: echo "hello from \${{ github.repository }} at \${{ github.sha }}"
      - name: Deploy with wrangler
        working-directory: site
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
`

const children: ChildProcess[] = []
let server: RunningServer | undefined

afterAll(async () => {
  for (const child of children) child.kill('SIGINT')
  await server?.close()
})

describe.skipIf('skip' in runner)(`official actions/runner${'skip' in runner ? ` (skipped: ${runner.skip})` : ''}`, () => {
  it('registers via JIT config, checks out from the forge, runs steps and a wrangler deploy', { timeout: 600_000 }, async () => {
    const runnerDir = (runner as { dir: string }).dir
    const output: string[] = []
    const launches: RunnerLaunch[] = []
    const launcher = {
      launch: async (launch: RunnerLaunch) => {
        launches.push(launch)
        const home = tempDir('git-forge-runner-')
        await run('cp', ['-a', `${runnerDir}/.`, home])
        const child = spawn(join(home, 'run.sh'), ['--jitconfig', launch.encodedJitConfig], {
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
        children.push(child)
      },
    }
    const forge = await createTestForge({ launcher, secrets: async () => (process.env['CLOUDFLARE_API_TOKEN'] ? { CLOUDFLARE_API_TOKEN: process.env['CLOUDFLARE_API_TOKEN'] } : {}) })
    server = await startServer(forge.handler)
    await createRepository(forge.storage, { owner: 'acme', name: 'site' })
    const source = initRepo()
    writeFile(source, '.github/workflows/deploy.yml', WORKFLOW)
    writeFile(source, 'src/index.js', "export default { fetch: () => new Response('hello from the forge') }\n")
    writeFile(source, 'wrangler.toml', 'name = "forge-hello"\nmain = "src/index.js"\ncompatibility_date = "2026-10-01"\n')
    commitAll(source, 'hello world worker')
    await run('git', ['push', '-q', `${server.url.replace('://', `://admin:${ADMIN_TOKEN}@`)}/acme/site.git`, 'main'], { cwd: source, env: { ...process.env, ...gitEnv } })

    expect(launches).toHaveLength(1)
    const requestId = launches[0]!.requestId
    const deadline = Date.now() + 540_000
    let job = await getJob(forge.db, requestId)
    while (job?.status !== 'completed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      job = await getJob(forge.db, requestId)
    }
    const logs = await (await fetch(`${server.url}/api/v3/repos/acme/site/actions/jobs/${requestId}/logs`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).text()
    const diagnostics = `runner output:\n${output.join('').slice(-20_000)}\njob logs:\n${logs.slice(-20_000)}`
    expect(job?.status, diagnostics).toBe('completed')
    expect(job?.conclusion, diagnostics).toBe('success')
    expect(logs, diagnostics).toContain('hello from acme/site')
    expect(logs, diagnostics).toMatch(/wrangler deploy --dry-run|Uploaded forge-hello/)
    const records = await listTimelineRecords(forge.db, job!.timeline_id)
    expect(records.map((record) => record['name'])).toEqual(expect.arrayContaining(['Checkout from the forge', 'Deploy with wrangler']))
  })
})
