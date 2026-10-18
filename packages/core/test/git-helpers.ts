import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const gitEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.org',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.org',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: tmpdir(),
}

export const tempDir = (prefix = 'git-forge-'): string => mkdtempSync(join(tmpdir(), prefix))

export const git = (cwd: string, args: readonly string[], options: ExecFileSyncOptions & { input?: Uint8Array | string } = {}): string =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...gitEnv }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options }) as string

export const gitBytes = (cwd: string, args: readonly string[], input?: Uint8Array | string): Uint8Array =>
  new Uint8Array(
    execFileSync('git', args, {
      cwd,
      env: { ...process.env, ...gitEnv },
      maxBuffer: 256 * 1024 * 1024,
      ...(input !== undefined ? { input } : {}),
    }),
  )

export const writeFile = (root: string, path: string, content: string | Uint8Array): void => {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

export const initRepo = (): string => {
  const dir = tempDir()
  git(dir, ['init', '-q', '-b', 'main'])
  return dir
}

export const commitAll = (dir: string, message: string): string => {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '--allow-empty', '-m', message])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

export const sampleHistory = (dir: string, commits = 5): string[] => {
  const ids: string[] = []
  for (let i = 0; i < commits; i++) {
    const lines = Array.from({ length: 200 }, (_, n) => `line ${n} of file ${i % 3} ${n % 7 === i ? 'changed' : ''}`)
    writeFile(dir, `docs/file-${i % 3}.md`, lines.join('\n'))
    writeFile(dir, `src/nested/deep/${i}.txt`, `content ${i}\n`)
    writeFile(dir, 'binary.bin', new Uint8Array(Array.from({ length: 4096 }, (_, n) => (n * (i + 1)) % 256)))
    ids.push(commitAll(dir, `commit ${i}`))
  }
  return ids
}
