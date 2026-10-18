import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { runGit } from './git.ts'

export const CLIENT_ID = 'git-forge-cli'

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

export type HostCredential = {
  readonly login: string
  readonly token: string
  readonly expiresAt: number | null
  readonly scope?: string
}

export type Hosts = Record<string, HostCredential>

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

export const SCOPES = ['repo:read', 'repo:write', 'repo:admin'] as const

export type Scope = (typeof SCOPES)[number]

export const DEFAULT_SCOPE: Scope = 'repo:write'

export const OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob'

export const isScope = (value: unknown): value is Scope => typeof value === 'string' && (SCOPES as readonly string[]).includes(value)

export type LoginRequest = {
  readonly scope: Scope
  readonly clientName: string
  readonly clientHost: string
}

export const defaultLoginRequest = (scope: Scope = DEFAULT_SCOPE): LoginRequest => ({ scope, clientName: 'git forge auth login', clientHost: hostname() })

export type DeviceIO = {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly sleep: (ms: number) => Promise<void>
  readonly log: (line: string) => void
  readonly now?: () => number
}

export type BrowserIO = DeviceIO & {
  readonly open?: (url: string) => boolean | Promise<boolean>
  readonly prompt: (question: string) => Promise<string>
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

const describeError = (body: Record<string, unknown>, status: number): string => String(body.error_description ?? body.error ?? status)

const credentialOf = (body: Record<string, unknown>, now: () => number): HostCredential => {
  const expiresIn = Number(body.expires_in)
  return {
    login: String(body.login ?? 'git-forge'),
    token: String(body.access_token),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : null,
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  }
}

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

export type Pkce = { readonly verifier: string; readonly challenge: string }

export const createPkce = async (): Promise<Pkce> => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  return { verifier, challenge }
}

const startAuthorization = async (host: string, io: DeviceIO, request: LoginRequest, input: { readonly redirectUri: string; readonly challenge: string; readonly state?: string }): Promise<string> => {
  const response = await io.fetch(
    `${host}/login/cli/start`,
    form({
      client_id: CLIENT_ID,
      redirect_uri: input.redirectUri,
      code_challenge: input.challenge,
      code_challenge_method: 'S256',
      scope: request.scope,
      client_name: request.clientName,
      client_host: request.clientHost,
      ...(input.state ? { state: input.state } : {}),
    }),
  )
  const body = await readJson(response)
  if (!response.ok || typeof body.authorization_url !== 'string') throw new Error(`${host} refused the login: ${describeError(body, response.status)}`)
  return body.authorization_url
}

export const exchangeCode = async (host: string, io: DeviceIO, input: { readonly code: string; readonly verifier: string; readonly redirectUri: string }): Promise<HostCredential> => {
  const response = await io.fetch(
    `${host}/login/cli/token`,
    form({ grant_type: 'authorization_code', client_id: CLIENT_ID, code: input.code.trim(), code_verifier: input.verifier, redirect_uri: input.redirectUri }),
  )
  const body = await readJson(response)
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new Error(body.error === 'invalid_grant' ? 'the code is wrong, expired or already used; run git forge auth login again' : `login failed: ${describeError(body, response.status)}`)
  }
  return credentialOf(body, io.now ?? Date.now)
}

const showLink = async (io: BrowserIO, url: string, verb: string): Promise<void> => {
  const opened = (await io.open?.(url)) ?? false
  io.log(opened ? `Opened your browser. If it did not open, visit:\n  ${url}` : `${verb}:\n  ${url}`)
}

export const pasteLogin = async (host: string, io: BrowserIO, request: LoginRequest = defaultLoginRequest()): Promise<HostCredential> => {
  const pkce = await createPkce()
  const url = await startAuthorization(host, io, request, { redirectUri: OOB_REDIRECT, challenge: pkce.challenge })
  await showLink(io, url, 'Open this link in a browser, approve, and copy the code it shows')
  const code = (await io.prompt('Paste the code: ')).trim()
  if (code === '') throw new Error('no code entered')
  return exchangeCode(host, io, { code, verifier: pkce.verifier, redirectUri: OOB_REDIRECT })
}

const CALLBACK_PAGE = (message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>git forge</title></head><body style="font-family:system-ui,sans-serif;margin:3rem"><p>${message}</p></body></html>`

const waitForCallback = (timeoutMs = 10 * 60 * 1000): Promise<{ readonly redirectUri: string; readonly result: Promise<URLSearchParams>; readonly close: () => void }> =>
  new Promise((ready, fail) => {
    let settle: (params: URLSearchParams) => void = () => undefined
    let reject: (error: Error) => void = () => undefined
    const result = new Promise<URLSearchParams>((done, failed) => {
      settle = done
      reject = failed
    })
    const server = createServer((incoming, outgoing) => {
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        outgoing.writeHead(404).end()
        return
      }
      const ok = url.searchParams.has('code')
      outgoing.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      outgoing.end(CALLBACK_PAGE(ok ? 'Logged in. You can close this window and return to your terminal.' : 'The login was not approved. You can close this window.'))
      settle(url.searchParams)
    })
    const timer = setTimeout(() => reject(new Error('timed out waiting for the browser; run git forge auth login again')), timeoutMs)
    const close = () => {
      clearTimeout(timer)
      server.close()
      server.closeAllConnections()
    }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || !address) return fail(new Error('could not listen on 127.0.0.1'))
      ready({ redirectUri: `http://127.0.0.1:${address.port}/callback`, result, close })
    })
  })

export const redirectLogin = async (host: string, io: BrowserIO, request: LoginRequest = defaultLoginRequest()): Promise<HostCredential> => {
  const pkce = await createPkce()
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)))
  const callback = await waitForCallback()
  try {
    const url = await startAuthorization(host, io, request, { redirectUri: callback.redirectUri, challenge: pkce.challenge, state })
    await showLink(io, url, 'Open this link in a browser on this computer and approve')
    const params = await callback.result
    if (params.get('state') !== state) throw new Error('the browser answered with a wrong state; run git forge auth login again')
    const code = params.get('code')
    if (!code) throw new Error(params.get('error') === 'access_denied' ? 'the login was denied in the browser' : `login failed: ${params.get('error') ?? 'no code'}`)
    return await exchangeCode(host, io, { code, verifier: pkce.verifier, redirectUri: callback.redirectUri })
  } finally {
    callback.close()
  }
}

export const deviceLogin = async (host: string, io: DeviceIO, request: LoginRequest = defaultLoginRequest()): Promise<HostCredential> => {
  const now = io.now ?? Date.now
  const started = await io.fetch(`${host}/login/device/code`, form({ client_id: CLIENT_ID, client_name: request.clientName, client_host: request.clientHost, scope: request.scope }))
  const device = await readJson(started)
  if (!started.ok) throw new Error(`${host} refused the device login: ${describeError(device, started.status)}`)
  const deviceCode = String(device.device_code)
  io.log(`Open this link in a signed-in browser and approve the request with code ${String(device.user_code)}:`)
  io.log(`  ${String(device.verification_uri_complete ?? device.verification_uri)}`)
  let interval = Number(device.interval) || 5
  const deadline = now() + (Number(device.expires_in) || 900) * 1000
  while (now() < deadline) {
    await io.sleep(interval * 1000)
    const response = await io.fetch(`${host}/login/device/token`, form({ grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode, client_id: CLIENT_ID }))
    if (response.status === 429) {
      interval = Math.max(interval, Number(response.headers.get('Retry-After')) || interval * 2)
      continue
    }
    const body = await readJson(response)
    if (response.ok && typeof body.access_token === 'string') return credentialOf(body, now)
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

export type Environment = Readonly<Record<string, string | undefined>>

export const isRemoteSession = (env: Environment = process.env): boolean => !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.CODESPACES || env.REMOTE_CONTAINERS)

export const browserCommand = (url: string, env: Environment = process.env, platform: string = process.platform): readonly string[] | null => {
  if (env.BROWSER) return env.BROWSER === 'none' ? null : [env.BROWSER, url]
  if (isRemoteSession(env)) return null
  if (platform === 'darwin') return ['open', url]
  if (platform === 'win32') return ['rundll32', 'url.dll,FileProtocolHandler', url]
  return env.DISPLAY || env.WAYLAND_DISPLAY ? ['xdg-open', url] : null
}

export const openBrowser = (url: string, env: Environment = process.env): Promise<boolean> =>
  new Promise((done) => {
    const command = browserCommand(url, env)
    if (!command) return done(false)
    const child = spawn(command[0]!, command.slice(1), { stdio: 'ignore', detached: true })
    child.once('error', () => done(false))
    child.once('spawn', () => {
      child.unref()
      done(true)
    })
  })

export type LoginArguments = {
  readonly target: string | undefined
  readonly scope: Scope
  readonly mode: 'paste' | 'redirect' | 'device'
  readonly openBrowser: boolean
  readonly setupGit: boolean
}

export const parseLoginArguments = (args: readonly string[]): LoginArguments => {
  let target: string | undefined
  let scope: Scope = DEFAULT_SCOPE
  let mode: LoginArguments['mode'] = 'paste'
  let browser = true
  let git = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (flag === '--scopes' || flag === '--scope') {
      const value = inline ?? args[++i]
      if (!isScope(value)) throw new Error(`${flag} must be repo:read, repo:write or repo:admin`)
      scope = value
    } else if (flag === '--browser-redirect') mode = 'redirect'
    else if (flag === '--device') mode = 'device'
    else if (flag === '--no-browser') browser = false
    else if (flag === '--no-setup-git') git = false
    else if (flag.startsWith('-')) throw new Error(`unknown option ${flag}`)
    else if (target === undefined) target = arg
    else throw new Error(`unexpected argument ${arg}`)
  }
  return { target, scope, mode, openBrowser: browser, setupGit: git }
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
