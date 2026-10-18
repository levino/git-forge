import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { tempDir } from '@git-forge/core/test/git-helpers.ts'
import { describe, expect, it } from 'vitest'
import {
  browserCommand,
  createPkce,
  credentialHelperCommand,
  deviceLogin,
  gitCredential,
  normalizeHost,
  OOB_REDIRECT,
  parseLoginArguments,
  pasteLogin,
  readHosts,
  redirectLogin,
  setupGit,
  writeHosts,
} from '../src/auth.ts'
import { createRemoteRepository, parseRepoCreate } from '../src/repo.ts'

const run = promisify(execFile)

const main = resolve(import.meta.dirname, '../src/main.ts')

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('device login', () => {
  it('polls until the browser approves, honoring slow_down', async () => {
    const answers = [reply(400, { error: 'authorization_pending' }), reply(400, { error: 'slow_down', interval: 10 }), reply(200, { access_token: 'gfp_x', login: 'alice', expires_in: 60 })]
    const calls: { url: string; body: string }[] = []
    const sleeps: number[] = []
    const lines: string[] = []
    const credential = await deviceLogin(
      'https://forge.example',
      {
        fetch: async (url, init) => {
          calls.push({ url, body: String(init?.body) })
          if (url.endsWith('/login/device/code')) {
            return reply(200, { device_code: 'gfd_1', user_code: 'BCDF-GHJK', verification_uri: 'https://forge.example/login/device', verification_uri_complete: 'https://forge.example/login/device?user_code=BCDF-GHJK', expires_in: 900, interval: 5 })
          }
          return answers.shift()!
        },
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        log: (line) => lines.push(line),
        now: () => 1000,
      },
      { scope: 'repo:admin', clientName: 'test client', clientHost: 'laptop' },
    )
    expect(credential).toEqual({ login: 'alice', token: 'gfp_x', expiresAt: 61_000 })
    expect(sleeps).toEqual([5000, 5000, 10_000])
    expect(lines.join('\n')).toContain('https://forge.example/login/device?user_code=BCDF-GHJK')
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ client_id: 'git-forge-cli', client_name: 'test client', client_host: 'laptop', scope: 'repo:admin' })
    expect(Object.fromEntries(new URLSearchParams(calls[1]!.body))).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'gfd_1', client_id: 'git-forge-cli' })
  })

  it('stops when the login is denied', async () => {
    const io = {
      fetch: async (url: string) =>
        url.endsWith('/code') ? reply(200, { device_code: 'd', user_code: 'u', verification_uri: 'v', interval: 1, expires_in: 10 }) : reply(400, { error: 'access_denied' }),
      sleep: async () => undefined,
      log: () => undefined,
    }
    await expect(deviceLogin('https://forge.example', io)).rejects.toThrow(/denied/)
  })
})

const S256 = async (verifier: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')

describe('browser login', () => {
  it('creates RFC 7636 verifiers and challenges', async () => {
    const pkce = await createPkce()
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pkce.challenge).toBe(await S256(pkce.verifier))
  })

  it('pastes the code shown in the browser and redeems it with the PKCE verifier', async () => {
    const calls: { url: string; fields: Record<string, string> }[] = []
    const lines: string[] = []
    const opened: string[] = []
    const credential = await pasteLogin(
      'https://forge.example',
      {
        fetch: async (url, init) => {
          calls.push({ url, fields: Object.fromEntries(new URLSearchParams(String(init?.body))) })
          if (url.endsWith('/login/cli/start')) return reply(200, { request_id: 'r'.repeat(22), authorization_url: 'https://forge.example/login/cli/rrrr', expires_in: 600 })
          return reply(200, { access_token: 'gfp_y', login: 'alice', scope: 'repo:admin', expires_in: 60 })
        },
        sleep: async () => undefined,
        log: (line) => lines.push(line),
        open: (url) => {
          opened.push(url)
          return false
        },
        prompt: async () => '  gfc_code \n',
        now: () => 0,
      },
      { scope: 'repo:admin', clientName: 'cli', clientHost: 'laptop' },
    )
    expect(credential).toEqual({ login: 'alice', token: 'gfp_y', expiresAt: 60_000, scope: 'repo:admin' })
    expect(opened).toEqual(['https://forge.example/login/cli/rrrr'])
    expect(lines.join('\n')).toContain('https://forge.example/login/cli/rrrr')
    const [start, token] = calls
    expect(start!.fields).toMatchObject({ client_id: 'git-forge-cli', redirect_uri: OOB_REDIRECT, code_challenge_method: 'S256', scope: 'repo:admin', client_host: 'laptop' })
    expect(token!.url).toBe('https://forge.example/login/cli/token')
    expect(token!.fields).toMatchObject({ grant_type: 'authorization_code', code: 'gfc_code', redirect_uri: OOB_REDIRECT })
    expect(await S256(token!.fields.code_verifier!)).toBe(start!.fields.code_challenge)
  })

  it('reports a wrong or reused code', async () => {
    const io = {
      fetch: async (url: string) => (url.endsWith('/start') ? reply(200, { authorization_url: 'https://forge.example/login/cli/x' }) : reply(400, { error: 'invalid_grant' })),
      sleep: async () => undefined,
      log: () => undefined,
      prompt: async () => 'gfc_wrong',
    }
    await expect(pasteLogin('https://forge.example', io)).rejects.toThrow(/wrong, expired or already used/)
  })

  it('receives the code on a loopback port and checks the state', async () => {
    let started: Record<string, string> = {}
    const credential = await redirectLogin('https://forge.example', {
      fetch: async (url, init) => {
        const fields = Object.fromEntries(new URLSearchParams(String(init?.body)))
        if (url.endsWith('/login/cli/start')) {
          started = fields
          const callback = new URL(fields.redirect_uri!)
          callback.searchParams.set('code', 'gfc_loop')
          callback.searchParams.set('state', fields.state!)
          setTimeout(() => void fetch(callback), 10)
          return reply(200, { authorization_url: 'https://forge.example/login/cli/abc' })
        }
        expect(fields).toMatchObject({ code: 'gfc_loop', redirect_uri: started.redirect_uri })
        return reply(200, { access_token: 'gfp_z', login: 'bob', expires_in: 60 })
      },
      sleep: async () => undefined,
      log: () => undefined,
      prompt: async () => '',
    })
    expect(started.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(credential.token).toBe('gfp_z')
  })

  it('parses login arguments', () => {
    expect(parseLoginArguments(['https://forge.example', '--scopes', 'repo:admin', '--no-setup-git'], true)).toEqual({
      target: 'https://forge.example',
      scope: 'repo:admin',
      mode: 'paste',
      openBrowser: true,
      setupGit: false,
    })
    expect(parseLoginArguments(['--scopes=repo:read', '--device', '--no-browser'])).toMatchObject({ target: undefined, scope: 'repo:read', mode: 'device', openBrowser: false })
    expect(parseLoginArguments(['--browser-redirect']).mode).toBe('redirect')
    expect(parseLoginArguments([], false).mode).toBe('device')
    expect(() => parseLoginArguments(['--scopes', 'repo:root'])).toThrow(/repo:read/)
  })

  it('opens a browser only where one can reach the link', () => {
    expect(browserCommand('u', { BROWSER: 'firefox' })).toEqual(['firefox', 'u'])
    expect(browserCommand('u', { BROWSER: 'none' })).toBeNull()
    expect(browserCommand('u', { SSH_CONNECTION: '1 2 3 4', DISPLAY: ':0' }, 'linux')).toBeNull()
    expect(browserCommand('u', {}, 'linux')).toBeNull()
    expect(browserCommand('u', { DISPLAY: ':0' }, 'linux')).toEqual(['xdg-open', 'u'])
    expect(browserCommand('u', {}, 'darwin')).toEqual(['open', 'u'])
  })
})

describe('repo create', () => {
  it('parses names and options', () => {
    expect(parseRepoCreate(['acme/site', '--public', '--default-branch', 'trunk', '--remote=origin'])).toEqual({
      owner: 'acme',
      name: 'site',
      visibility: 'public',
      defaultBranch: 'trunk',
      remote: 'origin',
      host: null,
    })
    expect(parseRepoCreate(['site.git', '--private'])).toMatchObject({ owner: null, name: 'site', visibility: 'private' })
    expect(() => parseRepoCreate(['a/b/c'])).toThrow(/invalid/)
    expect(() => parseRepoCreate([])).toThrow(/expected one repository/)
  })

  it('posts to the API with the stored token and explains a missing admin scope', async () => {
    const credential = { login: 'alice', token: 'gfp_a', expiresAt: null }
    let sent: { url: string; auth: string | null; body: unknown } | null = null
    const created = await createRemoteRepository('https://forge.example', credential, parseRepoCreate(['site']), async (url, init) => {
      sent = { url, auth: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) }
      return reply(201, { owner: 'alice', name: 'site', visibility: 'private', defaultBranch: 'main', cloneUrl: 'https://forge.example/alice/site.git' })
    })
    expect(created.cloneUrl).toBe('https://forge.example/alice/site.git')
    expect(sent).toEqual({ url: 'https://forge.example/api/repos', auth: 'Bearer gfp_a', body: { owner: 'alice', name: 'site', visibility: 'private' } })
    await expect(
      createRemoteRepository('https://forge.example', credential, parseRepoCreate(['site']), async () => reply(403, { error: 'this needs a personal access token with the repo:admin scope' })),
    ).rejects.toThrow(/--scopes repo:admin/)
  })
})

describe('credential helper', () => {
  const hosts = { 'https://forge.example': { login: 'alice', token: 'gfp_a', expiresAt: null }, 'http://127.0.0.1:8787': { login: 'bob', token: 'gfp_b', expiresAt: 10 } }

  it('answers get for stored hosts only', () => {
    expect(gitCredential('get', 'protocol=https\nhost=forge.example\npath=acme/site.git\n', hosts)).toBe('username=alice\npassword=gfp_a\n')
    expect(gitCredential('get', 'protocol=https\nhost=other.example\n', hosts)).toBe('')
    expect(gitCredential('get', 'protocol=http\nhost=127.0.0.1:8787\n', hosts, 5)).toBe('username=bob\npassword=gfp_b\n')
    expect(gitCredential('get', 'protocol=http\nhost=127.0.0.1:8787\n', hosts, 50)).toBe('')
    expect(gitCredential('store', 'protocol=https\nhost=forge.example\n', hosts)).toBe('')
  })

  it('normalizes hosts and keeps the token file private', () => {
    expect(normalizeHost('forge.example')).toBe('https://forge.example')
    expect(normalizeHost('http://127.0.0.1:8787/acme/site.git')).toBe('http://127.0.0.1:8787')
    const directory = join(tempDir('git-forge-config-'), 'nested')
    writeHosts(directory, hosts)
    expect(readHosts(directory)).toEqual(hosts)
    expect(statSync(join(directory, 'hosts.json')).mode & 0o777).toBe(0o600)
  })

  it('runs as git credential helper through the CLI', async () => {
    const directory = tempDir('git-forge-config-')
    writeHosts(directory, hosts)
    const child = execFile(process.execPath, ['--no-warnings', main, 'auth', 'git-credential', 'get'], { env: { ...process.env, GIT_FORGE_CONFIG_DIR: directory } })
    child.stdin!.end('protocol=https\nhost=forge.example\n\n')
    const output = await new Promise<string>((done) => {
      let text = ''
      child.stdout!.on('data', (chunk) => (text += chunk))
      child.on('close', () => done(text))
    })
    expect(output).toBe('username=alice\npassword=gfp_a\n')
  })

  it('configures git with an empty helper first, then the forge helper', async () => {
    const config = join(tempDir('git-forge-home-'), 'gitconfig')
    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = config
    try {
      await setupGit('https://forge.example', '!git-forge auth git-credential')
      await setupGit('https://forge.example', '!git-forge auth git-credential')
      const { stdout } = await run('git', ['config', '--global', '--get-all', 'credential.https://forge.example.helper'], { env: process.env })
      expect(stdout).toBe('\n!git-forge auth git-credential\n')
      expect(readFileSync(config, 'utf8')).toContain('[credential "https://forge.example"]')
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous
    }
  })

  it('points the helper at the running script during development', () => {
    expect(credentialHelperCommand(['node', main], '/usr/bin/node')).toBe(`!'/usr/bin/node' --no-warnings '${main}' auth git-credential`)
    expect(credentialHelperCommand(['/usr/local/bin/git-forge'], '/usr/local/bin/git-forge')).toBe(`!'/usr/local/bin/git-forge' auth git-credential`)
  })
})
