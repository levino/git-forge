import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type WranglerDev = {
  readonly url: string
  readonly output: () => string
  stop(): Promise<void>
}

export const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? done(address.port) : fail(new Error('no port'))))
    })
  })

const appRoot = resolve(import.meta.dirname, '../..')

export type WranglerDevOptions = {
  readonly vars: Record<string, string>
  readonly env?: string
  readonly port?: number
}

export const startWranglerDev = async (options: WranglerDevOptions): Promise<WranglerDev> => {
  const port = options.port ?? (await freePort())
  const persist = mkdtempSync(join(tmpdir(), 'git-forge-wrangler-'))
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' }
  const envArgs = options.env ? ['--env', options.env] : []
  await run(join(appRoot, 'node_modules/.bin/wrangler'), ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist, ...envArgs], {
    cwd: appRoot,
    env: environment,
  })
  const args = [
    'dev',
    ...envArgs,
    '--inspector-port',
    String(await freePort()),
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--persist-to',
    persist,
    '--test-scheduled',
    '--show-interactive-dev-session=false',
    ...Object.entries(options.vars).flatMap(([key, value]) => ['--var', `${key}:${value}`]),
  ]
  const child: ChildProcess = spawn(join(appRoot, 'node_modules/.bin/wrangler'), args, {
    cwd: appRoot,
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  const url = `http://127.0.0.1:${port}`
  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    process.kill(-child.pid, 'SIGTERM')
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))])
    if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL')
  }
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`)
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) return { url, output: () => log, stop }
    } catch {}
    await new Promise((done) => setTimeout(done, 250))
  }
  await stop()
  throw new Error(`wrangler dev did not become ready:\n${log}`)
}
