import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)

const releaseRoot = resolve(import.meta.dirname, '..')
const templateRoot = resolve(releaseRoot, '../templates/instance')
const wrangler = join(releaseRoot, 'node_modules/.bin/wrangler')
const BOOTSTRAP_TOKEN = `release-${crypto.randomUUID()}`

const gitEnv = {
  GIT_AUTHOR_NAME: 'Release',
  GIT_AUTHOR_EMAIL: 'release@example.org',
  GIT_COMMITTER_NAME: 'Release',
  GIT_COMMITTER_EMAIL: 'release@example.org',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: tmpdir(),
}

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'git-forge-release-'))

const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (await run('git', args, { cwd, env: { ...process.env, ...gitEnv } })).stdout

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

const pin = (instance: string, version: string, sum: string): void =>
  writeFileSync(join(instance, 'git-forge.json'), `${JSON.stringify({ version, sha256: sum }, null, 2)}\n`)

const newInstance = (version: string, sum: string): string => {
  const instance = join(tempDir(), 'instance')
  cpSync(templateRoot, instance, { recursive: true, filter: (path) => !/\/(dist|dist\.tmp|\.wrangler)(\/|$)/.test(path) })
  pin(instance, version, sum)
  return instance
}

type Result = { readonly code: number; readonly output: string }

const buildInstance = async (instance: string, releaseUrl: string): Promise<Result> => {
  try {
    const { stdout, stderr } = await run('sh', [join(instance, 'build.sh')], { env: { ...process.env, GIT_FORGE_RELEASE_URL: releaseUrl } })
    return { code: 0, output: stdout + stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? done(address.port) : fail(new Error('no port'))))
    })
  })

const wranglerEnv = (releaseUrl: string) => ({ ...process.env, GIT_FORGE_RELEASE_URL: releaseUrl, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' })

let release: string
let releaseUrl: string
let pinned: string
let instance: string
let persist: string
let child: ChildProcess | undefined
let url: string
let log = ''

const startDev = async (): Promise<void> => {
  const port = await freePort()
  child = spawn(
    wrangler,
    ['dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist, '--show-interactive-dev-session=false', '--var', `BOOTSTRAP_TOKEN:${BOOTSTRAP_TOKEN}`],
    { cwd: instance, detached: true, env: wranglerEnv(releaseUrl), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`)
    try {
      if ((await fetch(`${url}/api/health`)).ok) return
    } catch {}
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`wrangler dev did not become ready:\n${log}`)
}

const stopDev = async (): Promise<void> => {
  if (!child || child.exitCode !== null || child.pid === undefined) return
  const exited = new Promise<void>((done) => child?.once('exit', () => done()))
  process.kill(-child.pid, 'SIGTERM')
  await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))])
  if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL')
}

beforeAll(async () => {
  release = join(tempDir(), 'v0.0.0-test')
  const { stdout } = await run('sh', [join(releaseRoot, 'build-release.sh'), release])
  pinned = stdout.trim()
  releaseUrl = `file://${release}`
  instance = newInstance('0.0.0-test', pinned)
  persist = tempDir()
}, 180_000)

afterAll(async () => {
  await stopDev()
})

describe('release bundle', () => {
  it('publishes the bundle, the migrations and their checksums', async () => {
    expect(readdirSync(release).sort()).toEqual(['SHA256SUMS', 'git-forge-worker.mjs', 'migrations.tar.gz'])
    expect(pinned).toBe(sha256(join(release, 'SHA256SUMS')))
    const sums = readFileSync(join(release, 'SHA256SUMS'), 'utf8').trim().split('\n')
    expect(sums).toEqual([
      `${sha256(join(release, 'git-forge-worker.mjs'))}  git-forge-worker.mjs`,
      `${sha256(join(release, 'migrations.tar.gz'))}  migrations.tar.gz`,
    ])
    const bundle = readFileSync(join(release, 'git-forge-worker.mjs'), 'utf8')
    expect(bundle).toMatch(/export\s*\{[^}]*\bas default\b/)
    const imports = [...bundle.matchAll(/^import\s[^;]*?["']([^"']+)["']/gm)].map((match) => match[1])
    expect(imports.filter((specifier) => !specifier!.startsWith('cloudflare:'))).toEqual([])
    expect(bundle).not.toMatch(/\bimport\(\s*["'](?!cloudflare:)/)
    const { stdout } = await run('tar', ['-tzf', join(release, 'migrations.tar.gz')])
    expect(stdout.split('\n')).toContain('migrations/0001_initial.sql')
  })
})

describe('instance template build script', () => {
  it('refuses a release whose SHA256SUMS does not match the pin', async () => {
    const wrong = newInstance('0.0.0-test', '0'.repeat(64))
    const result = await buildInstance(wrong, releaseUrl)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('does not match the sha256 in git-forge.json')
    expect(existsSync(join(wrong, 'dist'))).toBe(false)
  })

  it('refuses a tampered bundle', async () => {
    const tampered = join(tempDir(), 'tampered')
    cpSync(release, tampered, { recursive: true })
    appendFileSync(join(tampered, 'git-forge-worker.mjs'), '\nconsole.log("tampered")\n')
    const other = newInstance('0.0.0-test', pinned)
    const result = await buildInstance(other, `file://${tampered}`)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('release assets do not match SHA256SUMS')
    expect(existsSync(join(other, 'dist'))).toBe(false)
  })

  it('downloads and verifies the pinned release, and is idempotent', async () => {
    const first = await buildInstance(instance, releaseUrl)
    expect(first).toMatchObject({ code: 0 })
    expect(readFileSync(join(instance, 'dist/git-forge-worker.mjs'))).toEqual(readFileSync(join(release, 'git-forge-worker.mjs')))
    expect(existsSync(join(instance, 'dist/migrations/0001_initial.sql'))).toBe(true)
    const second = await buildInstance(instance, 'file:///nonexistent')
    expect(second.code).toBe(0)
    expect(second.output).toContain('already matches')
  })

  it('applies the bundled D1 migrations', async () => {
    const { stdout, stderr } = await run(wrangler, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], { cwd: instance, env: wranglerEnv(releaseUrl) })
    expect(stdout + stderr).toContain('0001_initial.sql')
    expect(stdout + stderr).toContain('0003_instance_admins.sql')
  })
})

describe('instance template deploy script', () => {
  const deployWith = async (databaseExists: boolean): Promise<string[]> => {
    const target = newInstance('0.0.0-test', pinned)
    const calls = join(tempDir(), 'calls')
    const stub = join(tempDir(), 'wrangler')
    writeFileSync(stub, `#!/bin/sh\necho "$*" >> '${calls}'\nif [ "$1 $2" = "d1 info" ]; then exit ${databaseExists ? 0 : 1}; fi\n`, { mode: 0o755 })
    await run('sh', [join(target, 'deploy.sh')], { env: { ...process.env, GIT_FORGE_RELEASE_URL: releaseUrl, WRANGLER: stub } })
    expect(existsSync(join(target, 'dist/git-forge-worker.mjs'))).toBe(true)
    return readFileSync(calls, 'utf8').trim().split('\n')
  }

  it('migrates before deploying an existing instance', async () => {
    expect(await deployWith(true)).toEqual(['d1 info DB', 'd1 migrations apply DB --remote', 'deploy'])
  })

  it('deploys first to provision the database on the first deploy', async () => {
    expect(await deployWith(false)).toEqual(['d1 info DB', 'deploy', 'd1 migrations apply DB --remote'])
  })
})

describe('instance on wrangler dev', () => {
  it('serves a push and a clone with the real git client', async () => {
    await startDev()
    const post = (path: string, token: string, body: unknown) =>
      fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const bootstrapped = await post('/api/bootstrap', BOOTSTRAP_TOKEN, { login: 'smoke' })
    expect(bootstrapped.status).toBe(201)
    const { token } = (await bootstrapped.json()) as { token: string }
    expect((await post('/api/repos', token, { owner: 'smoke', name: 'site', visibility: 'public' })).status).toBe(201)
    const source = tempDir()
    await git(source, ['init', '-q', '-b', 'main'])
    for (let commit = 0; commit < 3; commit++) {
      writeFileSync(join(source, `file-${commit}.txt`), `commit ${commit}\n`)
      await git(source, ['add', '.'])
      await git(source, ['commit', '-q', '-m', `commit ${commit}`])
    }
    const remote = `${url}/smoke/site.git`
    await git(source, ['push', '-q', remote.replace('http://', `http://git:${token}@`), 'main'])
    const target = tempDir()
    await git(target, ['clone', '-q', remote, 'out'])
    expect(await git(join(target, 'out'), ['log', '--format=%H %s'])).toBe(await git(source, ['log', '--format=%H %s']))
    expect(await git(join(target, 'out'), ['fsck', '--full', '--strict'])).toBe('')
  })

  it('serves the web UI from the same bundle', async () => {
    const page = await fetch(`${url}/smoke/site`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('commit 2')
    expect(html).toContain('file-0.txt')
    const stylesheet = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1]
    expect((await fetch(`${url}${stylesheet}`)).headers.get('Content-Type')).toContain('text/css')
  })
})
