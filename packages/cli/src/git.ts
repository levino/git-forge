import { spawn } from 'node:child_process'
import type { GitOps, ObjectId } from './plan.ts'

export class GitError extends Error {
  readonly code: number | null
  readonly stderr: string

  constructor(args: readonly string[], code: number | null, stderr: string) {
    super(`git ${args.join(' ')} failed${code === null ? '' : ` with exit code ${code}`}${stderr ? `: ${stderr.trim()}` : ''}`)
    this.code = code
    this.stderr = stderr
  }
}

export type RunOptions = {
  readonly cwd?: string | undefined
  readonly input?: string
  readonly allowFailure?: boolean
}

export type RunResult = {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

export const runGit = (args: readonly string[], options: RunOptions = {}): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const result = { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code }
      if (code !== 0 && !options.allowFailure) reject(new GitError(args, code, result.stderr))
      else resolve(result)
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })

export const runGitInteractive = (args: readonly string[], cwd?: string): Promise<number | null> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['inherit', 'inherit', 'inherit'] })
    child.on('error', reject)
    child.on('close', resolve)
  })

const revisionInput = (tip: ObjectId, negatives: readonly ObjectId[]): string => `${[tip, ...negatives.map((id) => `^${id}`)].join('\n')}\n`

const lines = (text: string): string[] => text.split('\n').filter((line) => line.length > 0)

export const countPackBytes = (args: readonly string[], input: string, limit: number, cwd?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let bytes = 0
    let stopped = false
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > limit && !stopped) {
        stopped = true
        child.kill('SIGTERM')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (stopped) resolve(bytes)
      else if (code !== 0) reject(new GitError(args, code, Buffer.concat(err).toString('utf8')))
      else resolve(bytes)
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })

export const gitOps = (cwd?: string): GitOps => ({
  async firstParentLine(tip, negatives) {
    const { stdout } = await runGit(['rev-list', '--first-parent', '--reverse', '--stdin'], { cwd, input: revisionInput(tip, negatives) })
    return lines(stdout)
  },
  async parents(commit) {
    const { stdout } = await runGit(['rev-list', '--parents', '-n', '1', commit], { cwd })
    return lines(stdout)[0]?.split(' ').slice(1) ?? []
  },
  async covered(commit, negatives) {
    const { stdout } = await runGit(['rev-list', '-n', '1', '--stdin'], { cwd, input: revisionInput(commit, negatives) })
    return stdout.trim() === ''
  },
  async estimate(tip, negatives) {
    const { stdout } = await runGit(['rev-list', '--objects', '--disk-usage', '--stdin'], { cwd, input: revisionInput(tip, negatives) })
    return Number(stdout.trim())
  },
  packSize: (tip, negatives, limit) =>
    countPackBytes(['pack-objects', '--revs', '--stdout', '--thin', '--delta-base-offset', '-q'], revisionInput(tip, negatives), limit, cwd),
})

export const lsRemote = async (remote: string, cwd?: string): Promise<Map<string, ObjectId>> => {
  const { stdout } = await runGit(['ls-remote', remote], { cwd })
  const refs = new Map<string, ObjectId>()
  for (const line of lines(stdout)) {
    const [id, name] = line.split('\t')
    if (id && name && !name.endsWith('^{}')) refs.set(name, id)
  }
  return refs
}

export const presentObjects = async (ids: Iterable<ObjectId>, cwd?: string): Promise<Set<ObjectId>> => {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Set()
  const { stdout } = await runGit(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd, input: `${unique.join('\n')}\n` })
  const present = new Set<ObjectId>()
  for (const line of lines(stdout)) {
    const [id, type] = line.split(' ')
    if (id && type && type !== 'missing') present.add(id)
  }
  return present
}

export const resolve = async (revision: string, cwd?: string): Promise<ObjectId | null> => {
  const { stdout, code } = await runGit(['rev-parse', '--verify', '--quiet', revision], { cwd, allowFailure: true })
  return code === 0 ? stdout.trim() : null
}

export const fullName = async (revision: string, cwd?: string): Promise<string | null> => {
  const { stdout, code } = await runGit(['rev-parse', '--symbolic-full-name', revision], { cwd, allowFailure: true })
  const name = stdout.trim()
  return code === 0 && name.startsWith('refs/') ? name : null
}

export const isAncestor = async (ancestor: ObjectId, descendant: ObjectId, cwd?: string): Promise<boolean> => {
  const { code } = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd, allowFailure: true })
  return code === 0
}

export const configValue = async (key: string, cwd?: string): Promise<string | null> => {
  const { stdout, code } = await runGit(['config', '--get', key], { cwd, allowFailure: true })
  return code === 0 ? stdout.trim() : null
}
