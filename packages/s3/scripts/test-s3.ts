import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = process.env.S3_LOCAL_PORT ?? '7070'
const bucket = 'git-forge-test'
const accessKeyId = 'git-forge'
const secretAccessKey = 'git-forge-local-secret'
const here = new URL('..', import.meta.url).pathname

const reachable = async (endpoint: string): Promise<boolean> => {
  try {
    const response = await fetch(endpoint)
    await response.body?.cancel()
    return true
  } catch {
    return false
  }
}

const waitFor = async (endpoint: string): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (await reachable(endpoint)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`local S3 server at ${endpoint} did not come up`)
}

const hasCommand = (command: string, args: readonly string[]): boolean => spawnSync(command, args, { stdio: 'ignore' }).status === 0

const startNative = (binary: string): ChildProcess => {
  const data = mkdtempSync(join(tmpdir(), 'git-forge-versitygw-'))
  mkdirSync(join(data, 'root', bucket), { recursive: true })
  mkdirSync(join(data, 'sidecar'))
  return spawn(binary, ['--port', `127.0.0.1:${port}`, 'posix', '--sidecar', join(data, 'sidecar'), join(data, 'root')], {
    env: { ...process.env, ROOT_ACCESS_KEY: accessKeyId, ROOT_SECRET_KEY: secretAccessKey },
    stdio: 'ignore',
  })
}

const compose = (...args: string[]): void => {
  const result = spawnSync('docker', ['compose', '-f', join(here, 'compose.yaml'), ...args], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed`)
}

const runTests = (env: NodeJS.ProcessEnv): number =>
  spawnSync('pnpm', ['exec', 'vitest', 'run', ...process.argv.slice(2)], { cwd: here, env, stdio: 'inherit' }).status ?? 1

const main = async (): Promise<number> => {
  if (process.env.S3_TEST_ENDPOINT) return runTests(process.env)
  const endpoint = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    S3_TEST_ENDPOINT: endpoint,
    S3_TEST_BUCKET: bucket,
    S3_TEST_ACCESS_KEY_ID: accessKeyId,
    S3_TEST_SECRET_ACCESS_KEY: secretAccessKey,
  }
  const binary = process.env.VERSITYGW_BIN ?? 'versitygw'
  if (hasCommand(binary, ['--version'])) {
    const server = startNative(binary)
    try {
      await waitFor(endpoint)
      return runTests(env)
    } finally {
      server.kill()
    }
  }
  if (!hasCommand('docker', ['compose', 'version'])) {
    console.error('Neither versitygw nor docker compose is available; set S3_TEST_ENDPOINT or install one of them.')
    return 1
  }
  compose('up', '-d', '--wait')
  try {
    await waitFor(endpoint)
    return runTests(env)
  } finally {
    compose('down', '-v')
  }
}

process.exitCode = await main()
