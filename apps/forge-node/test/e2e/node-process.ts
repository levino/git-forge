import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const appRoot = resolve(import.meta.dirname, '../..')

export const command = (): [string, string[]] => {
  const binary = process.env.GIT_FORGE_NODE_BINARY
  if (binary) return [resolve(binary), []]
  return [process.execPath, ['--experimental-transform-types', '--no-warnings', resolve(appRoot, 'src/main.ts')]]
}

const environment = (env: Record<string, string>) => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env })

export const runCommand = async (args: readonly string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string }> => {
  const [file, prefix] = command()
  return run(file, [...prefix, ...args], { cwd: appRoot, env: environment(env) })
}

export type NodeProcess = {
  readonly url: string
  readonly output: () => string
  stop(): Promise<number | null>
}

export const startNodeInstance = async (env: Record<string, string> & { readonly PORT: string }): Promise<NodeProcess> => {
  const [file, prefix] = command()
  const child: ChildProcess = spawn(file, [...prefix, 'serve'], { cwd: appRoot, env: environment({ HOST: '127.0.0.1', ...env }), stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
  const url = `http://127.0.0.1:${env.PORT}`
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    const code = await Promise.race([exited, new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), 15_000))])
    if (code === 'timeout') {
      child.kill('SIGKILL')
      return exited
    }
    return code
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`git-forge-node exited early:\n${log}`)
    try {
      if ((await fetch(`${url}/api/health`)).ok) return { url, output: () => log, stop }
    } catch {}
    await new Promise((done) => setTimeout(done, 100))
  }
  await stop()
  throw new Error(`git-forge-node did not become ready:\n${log}`)
}
