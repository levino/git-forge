import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from '@git-forge/accounts'
import { libsqlDatabase } from '../src/index.ts'

export const sqldBinary: string | undefined = [process.env.SQLD_BIN, 'sqld'].find(
  (candidate): candidate is string => !!candidate && spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0,
)

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

const signToken = async (key: CryptoKey): Promise<string> => {
  const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)))
  const input = `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode({ a: 'rw' })}`
  return `${input}.${base64Url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(input))))}`
}

export const hostFetch =
  (host: string): typeof fetch =>
  async (input, init) => {
    const url = new URL(String(input))
    const headers = { ...(init?.headers as Record<string, string>), host }
    return new Promise<Response>((resolve, reject) => {
      const req = request(url, { method: init?.method ?? 'GET', headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500 })))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end(init?.body as string | undefined)
    })
  }

const waitFor = async (url: string): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    try {
      await (await fetch(url)).body?.cancel()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`sqld at ${url} did not come up`)
}

export const startSqld = async (binary: string): Promise<{ readonly env: Record<string, string>; stop(): void }> => {
  const dir = mkdtempSync(join(tmpdir(), 'git-forge-sqld-'))
  const [http, admin] = [await freePort(), await freePort()]
  const keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))
  const child: ChildProcess = spawn(
    binary,
    ['--no-welcome', '--db-path', join(dir, 'data.sqld'), '--http-listen-addr', `127.0.0.1:${http}`, '--admin-listen-addr', `127.0.0.1:${admin}`, '--enable-namespaces'],
    { env: { ...process.env, SQLD_AUTH_JWT_KEY: publicKey }, stdio: 'ignore' },
  )
  const stop = () => {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    await Promise.all([waitFor(`http://127.0.0.1:${http}/`), waitFor(`http://127.0.0.1:${admin}/`)])
  } catch (error) {
    stop()
    throw error
  }
  return { env: { SQLD_TEST_URL: `http://127.0.0.1:${http}`, SQLD_TEST_DEFAULT_URL: `http://localhost:${http}`, SQLD_TEST_ADMIN_URL: `http://127.0.0.1:${admin}`, SQLD_TEST_TOKEN: await signToken(keys.privateKey) }, stop }
}

export const sqldAvailable = (): boolean => !!process.env.SQLD_TEST_URL

let counter = 0

export const sqldDatabase = async (): Promise<Database> => {
  const { SQLD_TEST_URL: url, SQLD_TEST_ADMIN_URL: admin, SQLD_TEST_TOKEN: authToken } = process.env
  if (!url || !admin || !authToken) throw new Error('sqld is not running: put sqld on PATH or set SQLD_BIN, and use test/global-setup.ts')
  const namespace = `t${process.pid}x${++counter}`
  const created = await fetch(`${admin}/v1/namespaces/${namespace}/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  if (!created.ok) throw new Error(`creating namespace ${namespace}: ${created.status} ${await created.text()}`)
  return libsqlDatabase({ url, authToken, fetch: hostFetch(`${namespace}.localhost`) })
}
