import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { tempDir } from '@git-forge/core/test/git-helpers.ts'
import { describe, expect, it } from 'vitest'
import { credentialHelperCommand, deviceLogin, gitCredential, normalizeHost, readHosts, setupGit, writeHosts } from '../src/auth.ts'

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
      'test client',
    )
    expect(credential).toEqual({ login: 'alice', token: 'gfp_x', expiresAt: 61_000 })
    expect(sleeps).toEqual([5000, 5000, 10_000])
    expect(lines.join('\n')).toContain('BCDF-GHJK')
    expect(new URLSearchParams(calls[0]!.body).get('client_name')).toBe('test client')
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
