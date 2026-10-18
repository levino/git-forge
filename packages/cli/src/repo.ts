import type { HostCredential } from './auth.ts'

export type RepoCreateInput = {
  readonly owner: string | null
  readonly name: string
  readonly visibility: 'private' | 'public'
  readonly defaultBranch: string | null
  readonly remote: string | null
  readonly host: string | null
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const parseRepoCreate = (args: readonly string[]): RepoCreateInput => {
  let visibility: 'private' | 'public' = 'private'
  let defaultBranch: string | null = null
  let remote: string | null = null
  let host: string | null = null
  const positional: string[] = []
  const value = (index: number, flag: string): string => {
    const next = args[index]
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
    return next
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (flag === '--private') visibility = 'private'
    else if (flag === '--public') visibility = 'public'
    else if (flag === '--default-branch') defaultBranch = inline ?? value(++i, flag)
    else if (flag === '--remote') remote = inline ?? value(++i, flag)
    else if (flag === '--host') host = inline ?? value(++i, flag)
    else if (flag.startsWith('-')) throw new Error(`unknown option ${flag}`)
    else positional.push(arg)
  }
  if (positional.length !== 1) throw new Error('expected one repository, e.g. git forge repo create acme/site')
  const parts = positional[0]!.replace(/\.git$/, '').split('/')
  if (parts.length > 2 || !parts.every((part) => NAME.test(part))) throw new Error(`invalid repository name ${positional[0]}`)
  const [owner, name] = parts.length === 2 ? [parts[0]!, parts[1]!] : [null, parts[0]!]
  return { owner, name, visibility, defaultBranch, remote, host }
}

export type CreatedRepository = {
  readonly owner: string
  readonly name: string
  readonly visibility: string
  readonly defaultBranch: string
  readonly cloneUrl: string
}

export const createRemoteRepository = async (
  host: string,
  credential: HostCredential,
  input: RepoCreateInput,
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<CreatedRepository> => {
  const response = await fetcher(`${host}/api/repos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ owner: input.owner ?? credential.login, name: input.name, visibility: input.visibility, ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}) }),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (response.status === 403 && /repo:admin/.test(String(body.error))) {
    throw new Error(`creating repositories needs a token with admin access; run git forge auth login --scopes repo:admin ${host}`)
  }
  if (!response.ok) throw new Error(`${host} refused to create the repository: ${String(body.error ?? response.status)}`)
  return body as unknown as CreatedRepository
}
