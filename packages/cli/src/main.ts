import { configDirectory, credentialFor, deviceLogin, gitCredential, normalizeHost, readHosts, removeGitSetup, setupGit, writeHosts } from './auth.ts'
import { configValue, runGit } from './git.ts'
import { CommitTooLargeError } from './plan.ts'
import { DEFAULT_BUDGET, forgePush } from './push.ts'
import { isRemoteHelperName } from './helper-protocol.ts'
import { runRemoteHelper } from './remote-helper.ts'
import { formatSize, parseSize } from './size.ts'

export const VERSION = '0.1.0'

const USAGE = `usage: git forge push [options] <remote> <refspec>...
       git forge auth login [<url>] [--no-setup-git]
       git forge auth status | logout [<url>] | setup-git [<url>] | token [<url>]
       git forge auth git-credential <get|store|erase>
       git-remote-forge <remote> <url>   (git push/fetch forge::https://host/owner/repo)

Pushes history in several smaller pushes so that no single request exceeds
the budget, then performs the final ref update. Rerun to resume.

options:
  --max-bytes <size>  request budget per push (default 80MB; also
                      git config forge.maxPushBytes or GIT_FORGE_MAX_PUSH_BYTES)
  -f, --force         allow non-fast-forward updates (like +<refspec>)
  -n, --dry-run       print the chunks without pushing
  -h, --help          show this help
  --version           print the version

git forge auth login signs in through the browser (device flow), stores a
token for Git and Git LFS in ~/.config/git-forge/hosts.json and makes git use
it for that host through the credential helper git forge auth git-credential.
Without <url> it uses the host of the remote origin.

Invoked as git-remote-forge (a link to this executable on PATH), it is a git
remote helper for URLs forge::https://host/owner/repo: fetches use smart HTTP,
pushes upload the pack in parts directly to the forge's object storage and
resume after an interruption when you run git push again.`

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

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const resolveHost = async (explicit: string | undefined): Promise<string> => {
  if (explicit) return normalizeHost(explicit)
  const { stdout, code } = await runGit(['remote', 'get-url', 'origin'], { allowFailure: true })
  if (code !== 0 || stdout.trim() === '') throw new Error('pass the URL of the forge, e.g. git forge auth login https://forge.example')
  return normalizeHost(stdout.trim())
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

const auth = async (args: readonly string[]): Promise<number> => {
  const [action, ...rest] = args
  const flags = new Set(rest.filter((arg) => arg.startsWith('--')))
  const [target] = rest.filter((arg) => !arg.startsWith('--'))
  const directory = configDirectory()
  switch (action) {
    case 'login': {
      const host = await resolveHost(target)
      const credential = await deviceLogin(host, { fetch: (input, init) => fetch(input, init), sleep, log: (line) => process.stderr.write(`${line}\n`) })
      writeHosts(directory, { ...readHosts(directory), [host]: credential })
      if (!flags.has('--no-setup-git')) await setupGit(host)
      process.stderr.write(`Logged in to ${host} as ${credential.login}.${flags.has('--no-setup-git') ? '' : ' git now uses this token for that host.'}\n`)
      return 0
    }
    case 'logout': {
      const host = await resolveHost(target)
      const { [host]: removed, ...others } = readHosts(directory)
      writeHosts(directory, others)
      await removeGitSetup(host)
      process.stderr.write(removed ? `Logged out of ${host}. Revoke the token in the forge if it may have leaked.\n` : `Not logged in to ${host}.\n`)
      return 0
    }
    case 'status': {
      const hosts = readHosts(directory)
      if (Object.keys(hosts).length === 0) {
        process.stdout.write('Not logged in to any forge.\n')
        return 1
      }
      let healthy = true
      for (const [host, credential] of Object.entries(hosts)) {
        const response = await fetch(`${host}/api/user`, { headers: { Authorization: `Bearer ${credential.token}` } }).catch(() => null)
        const ok = response?.ok === true
        healthy &&= ok
        const expiry = credential.expiresAt ? `, expires ${new Date(credential.expiresAt).toISOString().slice(0, 10)}` : ''
        process.stdout.write(`${host}: ${credential.login}${expiry}${ok ? '' : ` (token rejected: ${response ? response.status : 'unreachable'})`}\n`)
      }
      return healthy ? 0 : 1
    }
    case 'setup-git': {
      const hosts = target ? [await resolveHost(target)] : Object.keys(readHosts(directory))
      for (const host of hosts) await setupGit(host)
      return 0
    }
    case 'token': {
      const host = await resolveHost(target)
      const url = new URL(host)
      const credential = credentialFor(new Map([['protocol', url.protocol.slice(0, -1)], ['host', url.host]]), readHosts(directory))
      if (!credential) throw new Error(`not logged in to ${host}`)
      process.stdout.write(`${credential.token}\n`)
      return 0
    }
    case 'git-credential': {
      const input = await readStdin()
      process.stdout.write(gitCredential(target ?? '', input, readHosts(directory)))
      return 0
    }
    default:
      process.stderr.write(`git-forge: unknown auth command ${action ?? ''}\n${USAGE}\n`)
      return 1
  }
}

const remoteHelper = async (args: readonly string[]): Promise<number> => {
  try {
    return await runRemoteHelper(args)
  } catch (error) {
    process.stderr.write(`git-remote-forge: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export const main = async (args: readonly string[], argv0: string = process.argv0): Promise<number> => {
  if (isRemoteHelperName(argv0)) return remoteHelper(args)
  const [command, ...rest] = args
  if (command === 'remote-helper') return remoteHelper(rest)
  if (command === '--version' || command === 'version') {
    process.stdout.write(`git-forge ${VERSION}\n`)
    return 0
  }
  if (!command || command === '-h' || command === '--help' || command === 'help' || rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${USAGE}\n`)
    return command ? 0 : 1
  }
  if (command === 'auth') {
    try {
      return await auth(rest)
    } catch (error) {
      process.stderr.write(`git-forge: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
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
