import { configValue } from './git.ts'
import { CommitTooLargeError } from './plan.ts'
import { DEFAULT_BUDGET, forgePush } from './push.ts'
import { formatSize, parseSize } from './size.ts'

export const VERSION = '0.1.0'

const USAGE = `usage: git forge push [options] <remote> <refspec>...

Pushes history in several smaller pushes so that no single request exceeds
the budget, then performs the final ref update. Rerun to resume.

options:
  --max-bytes <size>  request budget per push (default 80MB; also
                      git config forge.maxPushBytes or GIT_FORGE_MAX_PUSH_BYTES)
  -f, --force         allow non-fast-forward updates (like +<refspec>)
  -n, --dry-run       print the chunks without pushing
  -h, --help          show this help
  --version           print the version`

type Parsed = {
  readonly remote: string
  readonly refspecs: string[]
  readonly budget: string | null
  readonly force: boolean
  readonly dryRun: boolean
}

const parseArguments = (args: readonly string[]): Parsed => {
  const positional: string[] = []
  let budget: string | null = null
  let force = false
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (arg === '-f' || arg === '--force') force = true
    else if (arg === '-n' || arg === '--dry-run') dryRun = true
    else if (arg === '--max-bytes') {
      const value = args[++i]
      if (value === undefined) throw new Error('--max-bytes needs a value')
      budget = value
    } else if (arg.startsWith('--max-bytes=')) budget = arg.slice('--max-bytes='.length)
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else positional.push(arg)
  }
  const [remote, ...refspecs] = positional
  if (!remote || refspecs.length === 0) throw new Error('expected <remote> and at least one <refspec>')
  return { remote, refspecs, budget, force, dryRun }
}

const resolveBudget = async (explicit: string | null): Promise<number> => {
  const text = explicit ?? process.env.GIT_FORGE_MAX_PUSH_BYTES ?? (await configValue('forge.maxPushBytes'))
  return text ? parseSize(text) : DEFAULT_BUDGET
}

export const main = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args
  if (command === '--version' || command === 'version') {
    process.stdout.write(`git-forge ${VERSION}\n`)
    return 0
  }
  if (!command || command === '-h' || command === '--help' || command === 'help' || rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${USAGE}\n`)
    return command ? 0 : 1
  }
  if (command !== 'push') {
    process.stderr.write(`git-forge: unknown command ${command}\n${USAGE}\n`)
    return 1
  }
  try {
    const parsed = parseArguments(rest)
    const budget = await resolveBudget(parsed.budget)
    await forgePush({ remote: parsed.remote, refspecs: parsed.refspecs, budget, force: parsed.force, dryRun: parsed.dryRun })
    return 0
  } catch (error) {
    if (error instanceof CommitTooLargeError) {
      process.stderr.write(
        `git-forge: commit ${error.commit} alone needs more than ${formatSize(error.bytes)}, above the budget of ${formatSize(error.budget)}.\n` +
          'Split the commit or move large files to Git LFS (e.g. git lfs migrate import --include="*.bin").\n',
      )
      return 2
    }
    process.stderr.write(`git-forge: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
