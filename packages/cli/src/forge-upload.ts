import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { GitError, presentObjects, resolve as resolveRevision, runGit } from './git.ts'
import {
  type HelperOptions,
  partRanges,
  type PushSpec,
  type RefOutcome,
  refOutcomes,
  type ServerResult,
  splitCredentials,
  uploadKey,
  uploadsUrl,
  ZERO_ID,
} from './helper-protocol.ts'
import type { ObjectId } from './plan.ts'
import { formatSize } from './size.ts'

export type UploadPart = { readonly size: number; readonly sha256: string }

export type UploadState = {
  readonly version: 1
  readonly url: string
  readonly packSize: number
  readonly parts: readonly UploadPart[]
  readonly session: string | null
}

type ServerPart = UploadPart & {
  readonly number: number
  readonly uploaded: boolean
  readonly upload?: { readonly href: string; readonly header: Readonly<Record<string, string>> }
}

type SessionStatus = { readonly id: string; readonly expiresAt: string; readonly parts: readonly ServerPart[] }

type Discovery = { readonly maxPartBytes: number; readonly maxParts: number; readonly maxUploadBytes: number | null; readonly direct: boolean }

export type UploadEnvironment = {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly log: (line: string) => void
  readonly sleep: (ms: number) => Promise<void>
  readonly gitDir: string
  readonly partBytes?: number
  readonly retries?: number
  readonly concurrency?: number
}

export class ForgeHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const STATE_MAX_AGE_MS = 7 * 24 * 3600 * 1000

type Credential = { readonly username: string; readonly password: string }

const credentialInput = (url: string, credential?: Credential): string =>
  `url=${url}\n${credential ? `username=${credential.username}\npassword=${credential.password}\n` : ''}\n`

const fillCredential = async (url: string): Promise<Credential | null> => {
  const { stdout, code } = await runGit(['credential', 'fill'], { input: credentialInput(url), allowFailure: true })
  if (code !== 0) return null
  const fields = new Map(stdout.split('\n').flatMap((line) => (line.includes('=') ? [[line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const] : [])))
  const username = fields.get('username')
  const password = fields.get('password')
  return username !== undefined && password !== undefined ? { username, password } : null
}

export const forgeClient = (httpUrl: string, environment: UploadEnvironment, embedded: Credential | null = null) => {
  const origin = new URL(httpUrl).origin
  let credential: Credential | null = embedded
  let approved = embedded !== null
  const authorization = () => (credential ? `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}` : null)
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    const sameOrigin = new URL(url).origin === origin
    const attempt = () => {
      const headers = new Headers(init.headers)
      const auth = authorization()
      if (sameOrigin && auth && !headers.has('Authorization')) headers.set('Authorization', auth)
      return environment.fetch(url, { ...init, headers })
    }
    let response = await attempt()
    if (response.status === 401 && sameOrigin && credential === null) {
      await response.body?.cancel()
      credential = await fillCredential(httpUrl)
      if (!credential) throw new ForgeHttpError(401, `${httpUrl}: authentication required and no credentials available`)
      response = await attempt()
    }
    if (response.status === 401 && sameOrigin && credential) {
      if (embedded) throw new ForgeHttpError(401, `${httpUrl}: credentials in the URL rejected`)
      await runGit(['credential', 'reject'], { input: credentialInput(httpUrl, credential), allowFailure: true })
      throw new ForgeHttpError(401, `${httpUrl}: credentials rejected`)
    }
    if (response.ok && credential && !approved) {
      approved = true
      await runGit(['credential', 'approve'], { input: credentialInput(httpUrl, credential), allowFailure: true })
    }
    return response
  }
  const jsonRequest = async <T>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await send(url, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {}
    if (!response.ok && response.status !== 404 && response.status !== 410 && response.status !== 409) {
      const message = typeof parsed === 'object' && parsed !== null && 'message' in parsed ? String((parsed as { message: unknown }).message) : text.trim()
      throw new ForgeHttpError(response.status, `${method} ${url}: ${response.status} ${message}`.trim())
    }
    return { status: response.status, body: parsed as T }
  }
  return { send, jsonRequest }
}

type Client = ReturnType<typeof forgeClient>

const stateDirectory = (gitDir: string) => join(gitDir, 'forge-upload')

const pruneStates = (gitDir: string, keep: string, now: number) => {
  const root = stateDirectory(gitDir)
  if (!existsSync(root)) return
  for (const entry of readdirSync(root)) {
    if (entry === keep) continue
    const path = join(root, entry)
    if (now - statSync(path).mtimeMs > STATE_MAX_AGE_MS) rmSync(path, { recursive: true, force: true })
  }
}

const writeState = (directory: string, state: UploadState) => {
  const file = join(directory, 'state.json')
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

const readState = (directory: string, url: string): UploadState | null => {
  const file = join(directory, 'state.json')
  if (!existsSync(file) || !existsSync(join(directory, 'pack'))) return null
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as UploadState
    return state.version === 1 && state.url === url && statSync(join(directory, 'pack')).size === state.packSize ? state : null
  } catch {
    return null
  }
}

const writePack = (file: string, input: string, progress: boolean): Promise<void> =>
  new Promise((resolve, reject) => {
    const args = ['pack-objects', '--revs', '--stdout', '--thin', '--delta-base-offset', progress ? '--progress' : '-q']
    const child = spawn('git', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = createWriteStream(file)
    const err: Buffer[] = []
    let exit: number | null | undefined
    let flushed = false
    const settle = () => {
      if (exit === undefined || !flushed) return
      if (exit === 0) resolve()
      else reject(new GitError(args, exit, Buffer.concat(err).toString('utf8')))
    }
    child.stdout.pipe(out)
    child.stderr.on('data', (chunk: Buffer) => {
      err.push(chunk)
      if (progress) process.stderr.write(chunk)
    })
    out.on('finish', () => {
      flushed = true
      settle()
    })
    out.on('error', reject)
    child.on('error', reject)
    child.on('close', (code) => {
      exit = code
      settle()
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })

const hashRange = (file: string, offset: number, size: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file, { start: offset, end: offset + size - 1 })
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })

const readRange = async (file: string, offset: number, size: number): Promise<Uint8Array> => {
  const handle = await open(file, 'r')
  try {
    const buffer = new Uint8Array(size)
    let read = 0
    while (read < size) {
      const { bytesRead } = await handle.read(buffer, read, size - read, offset + read)
      if (bytesRead === 0) throw new Error(`pack file ended at ${offset + read}`)
      read += bytesRead
    }
    return buffer
  } finally {
    await handle.close()
  }
}

const preparePack = async (
  directory: string,
  url: string,
  wanted: readonly ObjectId[],
  negatives: readonly ObjectId[],
  partBytes: number,
  options: HelperOptions,
): Promise<UploadState> => {
  const existing = readState(directory, url)
  if (existing) return existing
  mkdirSync(directory, { recursive: true })
  const pack = join(directory, 'pack')
  if (wanted.length === 0) {
    writeFileSync(pack, '')
  } else {
    await writePack(`${pack}.tmp`, `${[...wanted, ...negatives.map((id) => `^${id}`)].join('\n')}\n`, options.progress)
    renameSync(`${pack}.tmp`, pack)
  }
  const packSize = statSync(pack).size
  const parts: UploadPart[] = []
  for (const range of partRanges(packSize, partBytes)) parts.push({ size: range.size, sha256: await hashRange(pack, range.offset, range.size) })
  const state: UploadState = { version: 1, url, packSize, parts, session: null }
  writeState(directory, state)
  return state
}

const openSession = async (client: Client, base: string, directory: string, state: UploadState): Promise<{ state: UploadState; status: SessionStatus }> => {
  if (state.session) {
    const current = await client.jsonRequest<SessionStatus>('GET', `${base}/${state.session}`)
    if (current.status === 200) return { state, status: current.body }
  }
  const created = await client.jsonRequest<SessionStatus & { message?: string }>('POST', base, { parts: state.parts })
  if (created.status !== 201) throw new ForgeHttpError(created.status, `could not start the upload: ${created.body?.message ?? created.status}`)
  const next: UploadState = { ...state, session: created.body.id }
  writeState(directory, next)
  return { state: next, status: created.body }
}

const uploadPart = async (client: Client, pack: string, state: UploadState, part: ServerPart): Promise<void> => {
  if (!part.upload) throw new Error(`no upload URL for part ${part.number}`)
  const offset = state.parts.slice(0, part.number - 1).reduce((sum, spec) => sum + spec.size, 0)
  const body = await readRange(pack, offset, part.size)
  const headers = new Headers(part.upload.header)
  headers.set('Content-Length', String(part.size))
  const response = await client.send(part.upload.href, { method: 'PUT', headers, body: body as Uint8Array<ArrayBuffer> })
  const text = await response.text().catch(() => '')
  if (!response.ok) throw new ForgeHttpError(response.status, `part ${part.number}: ${response.status} ${text.trim().slice(0, 200)}`.trim())
}

const uploadMissing = async (client: Client, base: string, pack: string, state: UploadState, status: SessionStatus, environment: UploadEnvironment): Promise<void> => {
  const retries = environment.retries ?? 2
  let missing = status.parts.filter((part) => !part.uploaded)
  const total = state.parts.length
  let done = total - missing.length
  if (missing.length > 0 && done > 0) environment.log(`forge: resuming upload, ${done} of ${total} parts already on the server`)
  for (let round = 0; missing.length > 0; round++) {
    const failures: { part: ServerPart; error: unknown }[] = []
    const queue = [...missing]
    const worker = async () => {
      for (let part = queue.shift(); part; part = queue.shift()) {
        try {
          await uploadPart(client, pack, state, part)
          done++
          environment.log(`forge: uploaded part ${done}/${total} (${formatSize(part.size)})`)
        } catch (error) {
          failures.push({ part, error })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(environment.concurrency ?? 3, queue.length) }, worker))
    if (failures.length === 0) return
    if (round >= retries) {
      const first = failures[0]?.error
      throw new Error(`upload interrupted (${failures.length} of ${total} parts missing): ${first instanceof Error ? first.message : String(first)}; run git push again to resume`)
    }
    await environment.sleep(500 * 2 ** round)
    const refreshed = await client.jsonRequest<SessionStatus>('GET', `${base}/${state.session}`)
    if (refreshed.status !== 200) throw new ForgeHttpError(refreshed.status, 'the upload session expired; run git push again')
    missing = refreshed.body.parts.filter((part) => !part.uploaded)
  }
}

export const discoverUploads = async (client: Client, httpUrl: string): Promise<Discovery | null> => {
  const discovery = await client.jsonRequest<Discovery>('GET', uploadsUrl(httpUrl))
  return discovery.status === 200 && discovery.body && typeof discovery.body.maxPartBytes === 'number' ? discovery.body : null
}

export const uploadPush = async (
  remoteUrl: string,
  specs: readonly PushSpec[],
  remoteRefs: ReadonlyMap<string, ObjectId>,
  options: HelperOptions,
  environment: UploadEnvironment,
): Promise<[string, RefOutcome][] | null> => {
  const { url: httpUrl, credential } = splitCredentials(remoteUrl)
  const client = forgeClient(httpUrl, environment, credential)
  const discovery = await discoverUploads(client, httpUrl)
  if (!discovery) return null
  const commands: { name: string; oldId: ObjectId; newId: ObjectId }[] = []
  const unresolved: [string, RefOutcome][] = []
  for (const spec of specs) {
    const newId = spec.src === null ? ZERO_ID : await resolveRevision(spec.src)
    if (newId === null) {
      unresolved.push([spec.dst, { ok: false, reason: `cannot resolve ${spec.src}` }])
      continue
    }
    commands.push({ name: spec.dst, oldId: options.cas.get(spec.dst) ?? remoteRefs.get(spec.dst) ?? ZERO_ID, newId })
  }
  if (unresolved.length > 0) return specs.map((spec) => unresolved.find(([dst]) => dst === spec.dst) ?? [spec.dst, { ok: false, reason: 'not pushed: another ref could not be resolved' }])
  if (options.dryRun) return specs.map((spec) => [spec.dst, { ok: true }])
  const wanted = commands.flatMap((command) => (command.newId === ZERO_ID ? [] : [command.newId]))
  const negatives = [...(await presentObjects(remoteRefs.values()))]
  const key = uploadKey(httpUrl, wanted, negatives)
  const directory = join(stateDirectory(environment.gitDir), key)
  pruneStates(environment.gitDir, key, Date.now())
  const partBytes = Math.min(discovery.maxPartBytes, environment.partBytes ?? discovery.maxPartBytes)
  const prepared = await preparePack(directory, httpUrl, wanted, negatives, partBytes, options)
  const total = prepared.packSize
  if (discovery.maxUploadBytes !== null && total > discovery.maxUploadBytes) {
    throw new Error(`the pack has ${formatSize(total)}, above the forge's upload limit of ${formatSize(discovery.maxUploadBytes)}`)
  }
  const base = uploadsUrl(httpUrl)
  const pack = join(directory, 'pack')
  const opened = await openSession(client, base, directory, prepared)
  let state = opened.state
  await uploadMissing(client, base, pack, state, opened.status, environment)
  for (let attempt = 0; ; attempt++) {
    const finalized = await client.jsonRequest<{ unpack: string; results: ServerResult[]; message?: string; missing?: number[] }>('POST', `${base}/${state.session}/finalize`, {
      commands,
      atomic: options.atomic,
    })
    if (finalized.status === 200) {
      const outcomes = refOutcomes(specs, finalized.body.unpack, finalized.body.results)
      if (outcomes.every(([, outcome]) => outcome.ok)) rmSync(directory, { recursive: true, force: true })
      return outcomes
    }
    if (attempt > 0 || (finalized.status !== 409 && finalized.status !== 410 && finalized.status !== 404)) {
      throw new ForgeHttpError(finalized.status, `finalize failed: ${finalized.body?.message ?? finalized.status}`)
    }
    const reopened = await openSession(client, base, directory, finalized.status === 409 ? state : { ...state, session: null })
    state = reopened.state
    await uploadMissing(client, base, pack, state, reopened.status, environment)
  }
}
