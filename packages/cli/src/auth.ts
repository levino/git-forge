import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { runGit } from './git.ts'

export const CLIENT_ID = 'git-forge-cli'

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

export type HostCredential = {
  readonly login: string
  readonly token: string
  readonly expiresAt: number | null
}

export type Hosts = Record<string, HostCredential>

export type Environment = Readonly<Record<string, string | undefined>>

export const configDirectory = (env: Environment = process.env): string =>
  env.GIT_FORGE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'git-forge')

const hostsFile = (directory: string) => join(directory, 'hosts.json')

export const readHosts = (directory: string): Hosts => {
  const file = hostsFile(directory)
  if (!existsSync(file)) return {}
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Hosts) : {}
}

export const writeHosts = (directory: string, hosts: Hosts): void => {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = hostsFile(directory)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(hosts, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}

export const normalizeHost = (input: string): string => {
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`
  const url = new URL(text)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`unsupported protocol in ${input}`)
  return url.origin
}

export type DeviceIO = {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly sleep: (ms: number) => Promise<void>
  readonly log: (line: string) => void
  readonly now?: () => number
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: new URLSearchParams(fields).toString(),
})

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = await response.json()
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  } catch {}
  throw new Error(`${response.url || 'server'} answered ${response.status} without JSON`)
}

export const deviceLogin = async (host: string, io: DeviceIO, clientName = `git forge auth login on ${hostname()}`): Promise<HostCredential> => {
  const now = io.now ?? Date.now
  const started = await io.fetch(`${host}/login/device/code`, form({ client_id: CLIENT_ID, client_name: clientName }))
  const device = await readJson(started)
  if (!started.ok) throw new Error(`${host} refused the device login: ${String(device.error_description ?? device.error ?? started.status)}`)
  const deviceCode = String(device.device_code)
  io.log(`First copy your one-time code: ${String(device.user_code)}`)
  io.log(`Then open ${String(device.verification_uri)} in your browser (or ${String(device.verification_uri_complete)}).`)
  let interval = Number(device.interval) || 5
  const deadline = now() + (Number(device.expires_in) || 900) * 1000
  while (now() < deadline) {
    await io.sleep(interval * 1000)
    const response = await io.fetch(`${host}/login/device/token`, form({ grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode, client_id: CLIENT_ID }))
    const body = await readJson(response)
    if (response.ok && typeof body.access_token === 'string') {
      const expiresIn = Number(body.expires_in)
      return { login: String(body.login ?? 'git-forge'), token: body.access_token, expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : null }
    }
    if (body.error === 'authorization_pending') continue
    if (body.error === 'slow_down') {
      interval = Number(body.interval) || interval + 5
      continue
    }
    if (body.error === 'access_denied') throw new Error('the login was denied in the browser')
    if (body.error === 'expired_token') throw new Error('the code expired; run git forge auth login again')
    throw new Error(`device login failed: ${String(body.error ?? response.status)}`)
  }
  throw new Error('the code expired; run git forge auth login again')
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export const credentialHelperCommand = (argv: readonly string[] = process.argv, execPath: string = process.execPath): string => {
  const script = argv[1]
  if (script && /\.(ts|mts|js|mjs)$/.test(script) && existsSync(script)) return `!${shellQuote(execPath)} --no-warnings ${shellQuote(script)} auth git-credential`
  return `!${shellQuote(execPath)} auth git-credential`
}

export const setupGit = async (host: string, command: string = credentialHelperCommand()): Promise<void> => {
  const key = `credential.${host}.helper`
  await runGit(['config', '--global', '--unset-all', key], { allowFailure: true })
  await runGit(['config', '--global', '--add', key, ''])
  await runGit(['config', '--global', '--add', key, command])
}

export const removeGitSetup = async (host: string): Promise<void> => {
  await runGit(['config', '--global', '--unset-all', `credential.${host}.helper`], { allowFailure: true })
}

export const parseCredentialRequest = (text: string): Map<string, string> => {
  const fields = new Map<string, string>()
  for (const line of text.split('\n')) {
    const index = line.indexOf('=')
    if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1).replace(/\r$/, ''))
  }
  return fields
}

export const credentialFor = (request: Map<string, string>, hosts: Hosts, now: number = Date.now()): HostCredential | null => {
  const protocol = request.get('protocol')
  const host = request.get('host')
  if ((protocol !== 'https' && protocol !== 'http') || !host) return null
  let origin: string
  try {
    origin = new URL(`${protocol}://${host}`).origin
  } catch {
    return null
  }
  const credential = hosts[origin]
  if (!credential || (credential.expiresAt !== null && credential.expiresAt <= now)) return null
  return credential
}

export const gitCredential = (action: string, input: string, hosts: Hosts, now: number = Date.now()): string => {
  if (action !== 'get') return ''
  const credential = credentialFor(parseCredentialRequest(input), hosts, now)
  return credential ? `username=${credential.login}\npassword=${credential.token}\n` : ''
}
