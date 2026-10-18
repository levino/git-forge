import { createHash } from 'node:crypto'
import type { ObjectId } from './plan.ts'

export const ZERO_ID: ObjectId = '0'.repeat(40)

export const isRemoteHelperName = (argv0: string): boolean => /^git-remote-forge(\.exe)?$/i.test(argv0.split(/[\\/]/).pop() ?? '')

export const CAPABILITIES = ['stateless-connect', 'fetch', 'push', 'option'] as const

export const capabilitiesResponse = (): string => `${CAPABILITIES.join('\n')}\n\n`

export const remoteHttpUrl = (url: string): string => {
  const text = url.startsWith('forge://') ? `https://${url.slice('forge://'.length)}` : url
  const parsed = new URL(text)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`git-remote-forge needs an http(s) URL, got ${url}`)
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString()
}

export type UrlCredential = { readonly username: string; readonly password: string }

export const splitCredentials = (httpUrl: string): { readonly url: string; readonly credential: UrlCredential | null } => {
  const parsed = new URL(httpUrl)
  if (parsed.username === '' && parsed.password === '') return { url: httpUrl, credential: null }
  const credential = { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
  parsed.username = ''
  parsed.password = ''
  return { url: parsed.toString(), credential }
}

export const uploadsUrl = (httpUrl: string): string => `${httpUrl.replace(/\/+$/, '')}/forge/uploads`

export type PushSpec = {
  readonly force: boolean
  readonly src: string | null
  readonly dst: string
}

export const parsePushLine = (line: string): PushSpec => {
  if (!line.startsWith('push ')) throw new Error(`not a push command: ${line}`)
  let spec = line.slice('push '.length)
  const force = spec.startsWith('+')
  if (force) spec = spec.slice(1)
  const colon = spec.lastIndexOf(':')
  if (colon === -1) throw new Error(`invalid push refspec: ${spec}`)
  const src = spec.slice(0, colon)
  const dst = spec.slice(colon + 1)
  if (!dst.startsWith('refs/')) throw new Error(`invalid push destination: ${dst}`)
  return { force, src: src === '' ? null : src, dst }
}

export const parseRefList = (text: string): Map<string, ObjectId> => {
  const refs = new Map<string, ObjectId>()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{40}) (\S+)/.exec(line)
    if (match) refs.set(match[2] as string, match[1] as ObjectId)
  }
  return refs
}

export type HelperOptions = {
  verbosity: number
  progress: boolean
  dryRun: boolean
  atomic: boolean
  readonly cas: Map<string, ObjectId>
}

export const defaultOptions = (): HelperOptions => ({ verbosity: 1, progress: false, dryRun: false, atomic: false, cas: new Map() })

export const applyOption = (options: HelperOptions, line: string): void => {
  const match = /^option (\S+) ?(.*)$/.exec(line)
  if (!match) return
  const [, name, value] = match as unknown as [string, string, string]
  if (name === 'verbosity') options.verbosity = Number(value) || 0
  else if (name === 'progress') options.progress = value === 'true'
  else if (name === 'dry-run') options.dryRun = value === 'true'
  else if (name === 'atomic') options.atomic = value === 'true'
  else if (name === 'cas') {
    const text = value.startsWith('"') ? (JSON.parse(value) as string) : value
    const colon = text.indexOf(':')
    const ref = colon === -1 ? text : text.slice(0, colon)
    const expected = colon === -1 ? '' : text.slice(colon + 1)
    if (/^[0-9a-f]{40}$/.test(expected)) options.cas.set(ref, expected)
    else if (expected === '') options.cas.set(ref, ZERO_ID)
  }
}

export type RefOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export const pushResponse = (results: readonly (readonly [string, RefOutcome])[]): string =>
  `${results.map(([dst, outcome]) => (outcome.ok ? `ok ${dst}` : `error ${dst} ${outcome.reason.replace(/\n/g, ' ')}`)).join('\n')}\n\n`

export const uploadKey = (url: string, wanted: readonly ObjectId[], negatives: readonly ObjectId[]): string =>
  createHash('sha256')
    .update(JSON.stringify({ url, wanted: [...new Set(wanted)].sort(), negatives: [...new Set(negatives)].sort() }))
    .digest('hex')
    .slice(0, 32)

export type PartRange = {
  readonly offset: number
  readonly size: number
}

export const partRanges = (total: number, partSize: number): PartRange[] => {
  if (!Number.isSafeInteger(partSize) || partSize <= 0) throw new Error(`invalid part size ${partSize}`)
  const ranges: PartRange[] = []
  for (let offset = 0; offset < total; offset += partSize) ranges.push({ offset, size: Math.min(partSize, total - offset) })
  return ranges
}

export type ServerResult = { readonly name: string; readonly ok: boolean; readonly reason?: string }

export const refOutcomes = (specs: readonly PushSpec[], unpack: string, results: readonly ServerResult[]): [string, RefOutcome][] =>
  specs.map((spec) => {
    const result = results.find((candidate) => candidate.name === spec.dst)
    if (result?.ok) return [spec.dst, { ok: true }]
    const reason = result?.reason ?? (unpack === 'ok' ? 'no result from the forge' : unpack.replace(/^error /, ''))
    return [spec.dst, { ok: false, reason }]
  })
