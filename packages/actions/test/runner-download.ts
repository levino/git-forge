import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { tempDir } from '@git-forge/core/test/git-helpers.ts'

const run = promisify(execFile)

const RUNNER_ARCH: Partial<Record<string, string>> = { x64: 'x64', arm64: 'arm64' }

const FALLBACK_RUNNER_VERSION = '2.329.0'

export const CHECKOUT_TAG = 'v4'

export const CONTAINER_HOOK = fileURLToPath(new URL('../../../apps/forge-worker/runner/hook.js', import.meta.url))

const latestRunnerVersion = async (): Promise<string> => {
  try {
    const release = await fetch('https://api.github.com/repos/actions/runner/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    if (release.ok) return ((await release.json()) as { tag_name: string }).tag_name.replace(/^v/, '')
  } catch {}
  return FALLBACK_RUNNER_VERSION
}

export const downloadRunner = async (): Promise<{ dir: string } | { skip: string }> => {
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

export const copyRunner = async (from: string): Promise<string> => {
  const home = tempDir('git-forge-runner-')
  try {
    await run('cp', ['-al', `${from}/.`, home])
  } catch {
    await run('cp', ['-a', `${from}/.`, home])
  }
  return home
}

export const runnerEnv = (home: string): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: home,
  LANG: 'C.UTF-8',
  RUNNER_ALLOW_RUNASROOT: '1',
  DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
  GITHUB_ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT: '1',
  ACTIONS_RUNNER_CONTAINER_HOOKS: CONTAINER_HOOK,
})
