import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const gitEnv = {
  GIT_AUTHOR_NAME: 'E2E',
  GIT_AUTHOR_EMAIL: 'e2e@example.org',
  GIT_COMMITTER_NAME: 'E2E',
  GIT_COMMITTER_EMAIL: 'e2e@example.org',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: tmpdir(),
}

export const tempDir = (): string => mkdtempSync(join(tmpdir(), 'git-forge-e2e-'))

export const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, ...gitEnv }, maxBuffer: 512 * 1024 * 1024 })
  return stdout
}

export const gitFails = async (cwd: string, args: readonly string[]): Promise<string> => {
  try {
    await git(cwd, args)
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error)
  }
  throw new Error(`git ${args.join(' ')} unexpectedly succeeded`)
}

const random = (seed: number) => {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

export type HistoryOptions = {
  readonly commits: number
  readonly files: number
  readonly binaryBytes: number
  readonly seed: number
  readonly branch?: string
  readonly from?: string
}

export const generateHistory = (dir: string, options: HistoryOptions): void => {
  const next = random(options.seed)
  const branch = options.branch ?? 'main'
  const chunks: Buffer[] = []
  const write = (text: string) => chunks.push(Buffer.from(text))
  const data = (content: Buffer) => {
    write(`data ${content.length}\n`)
    chunks.push(content)
    write('\n')
  }
  const texts = Array.from({ length: options.files }, (_, file) =>
    Array.from({ length: 120 }, (_, line) => `file ${file} line ${line} ${Math.floor(next() * 1e9).toString(36)}`),
  )
  const time = 1_767_225_600 + options.seed * 100_000
  for (let commit = 0; commit < options.commits; commit++) {
    write(`commit refs/heads/${branch}\n`)
    write(`committer E2E <e2e@example.org> ${time + commit * 60} +0000\n`)
    data(Buffer.from(`commit ${commit} (seed ${options.seed})\n`))
    if (commit === 0 && options.from) write(`from ${options.from}\n`)
    const touched = new Set<number>()
    for (let i = 0; i < 3; i++) touched.add(Math.floor(next() * options.files))
    for (const file of touched) {
      const lines = texts[file]!
      for (let i = 0; i < 4; i++) lines[Math.floor(next() * lines.length)] = `edit ${commit} ${Math.floor(next() * 1e9).toString(36)}`
      if (next() < 0.3) lines.push(`appended in ${commit}`)
      write(`M 100644 inline src/module-${file % 7}/file-${file}.txt\n`)
      data(Buffer.from(`${lines.join('\n')}\n`))
    }
    if (commit % 10 === 0) {
      const blob = Buffer.alloc(options.binaryBytes)
      for (let i = 0; i < blob.length; i++) blob[i] = Math.floor(next() * 256)
      write(`M 100644 inline assets/blob-${commit}.bin\n`)
      data(blob)
    }
    write('\n')
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, env: { ...process.env, ...gitEnv }, input: Buffer.concat(chunks) })
}
