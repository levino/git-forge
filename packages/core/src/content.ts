import { isObjectId, type ObjectId } from './hash.ts'
import { isLfsOid, parseLfsPointer, type LfsObjectSpec } from './lfs.ts'
import { isSubmodule, isTreeMode, parseCommit, parseTag, parseTree, type TreeEntry } from './objects.ts'
import { isValidName, type ObjectDatabase, type RefsState, type RepositoryName } from './repository.ts'
import type { ByteRange } from './storage.ts'

export type ContentRoute =
  | { readonly kind: 'media'; readonly repo: RepositoryName; readonly oid: string; readonly filename: string | null }
  | { readonly kind: 'raw'; readonly repo: RepositoryName; readonly segments: readonly string[] }

const CONTENT_ROUTE = /^\/([^/]+)\/([^/]+)\/(media|raw)\/(.+)$/

const decodeSegments = (path: string): string[] | null => {
  try {
    const segments = path.split('/').map((segment) => decodeURIComponent(segment))
    return segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\0'))
      ? null
      : segments
  } catch {
    return null
  }
}

export const matchContentRoute = (pathname: string): ContentRoute | null => {
  const match = CONTENT_ROUTE.exec(pathname)
  if (!match) return null
  const [, owner, name, kind, rest] = match as unknown as [string, string, string, 'media' | 'raw', string]
  if (!isValidName(owner) || !isValidName(name)) return null
  const repo = { owner, name }
  const segments = decodeSegments(rest)
  if (!segments) return null
  if (kind === 'raw') return segments.length >= 2 ? { kind, repo, segments } : null
  const [oid, filename, ...extra] = segments as [string, string | undefined, ...string[]]
  if (!isLfsOid(oid) || extra.length > 0) return null
  return { kind, repo, oid, filename: filename ?? null }
}

export type Revision = {
  readonly commit: ObjectId
  readonly immutable: boolean
  readonly path: readonly string[]
}

const peelToCommit = async (odb: ObjectDatabase, id: ObjectId): Promise<ObjectId | null> => {
  let current = id
  for (let depth = 0; depth < 10; depth++) {
    const object = await odb.read(current)
    if (!object) return null
    if (object.type === 'commit') return current
    if (object.type !== 'tag') return null
    current = parseTag(object.data).object
  }
  return null
}

const namedRef = (refs: RefsState, name: string): ObjectId | null => {
  if (name === 'HEAD') return refs.refs[refs.head] ?? null
  return refs.refs[`refs/tags/${name}`] ?? refs.refs[`refs/heads/${name}`] ?? null
}

export const resolveRevision = async (odb: ObjectDatabase, refs: RefsState, segments: readonly string[]): Promise<Revision | null> => {
  const [first] = segments
  if (first !== undefined && isObjectId(first) && segments.length >= 2) {
    const commit = await peelToCommit(odb, first)
    if (commit) return { commit, immutable: true, path: segments.slice(1) }
  }
  for (let length = segments.length - 1; length >= 1; length--) {
    const id = namedRef(refs, segments.slice(0, length).join('/'))
    if (id === null) continue
    const commit = await peelToCommit(odb, id)
    return commit ? { commit, immutable: false, path: segments.slice(length) } : null
  }
  return null
}

export const resolvePath = async (odb: ObjectDatabase, commit: ObjectId, path: readonly string[]): Promise<TreeEntry | null> => {
  const object = await odb.read(commit)
  if (!object || object.type !== 'commit') return null
  let entry: TreeEntry = { mode: '40000', name: '', id: parseCommit(object.data).tree }
  for (const segment of path) {
    if (!isTreeMode(entry.mode)) return null
    const tree = await odb.read(entry.id)
    if (!tree || tree.type !== 'tree') return null
    const next = parseTree(tree.data).find((candidate) => candidate.name === segment)
    if (!next || isSubmodule(next)) return null
    entry = next
  }
  return isTreeMode(entry.mode) ? null : entry
}

export type RawTarget =
  | { readonly kind: 'blob'; readonly id: ObjectId; readonly data: Uint8Array; readonly name: string; readonly immutable: boolean }
  | { readonly kind: 'lfs'; readonly pointer: LfsObjectSpec; readonly name: string; readonly immutable: boolean }
  | { readonly kind: 'not-found'; readonly message: string }

export const resolveRaw = async (
  odb: ObjectDatabase,
  refs: RefsState,
  segments: readonly string[],
  allowed?: (commit: ObjectId, path: readonly string[]) => Promise<boolean>,
): Promise<RawTarget> => {
  const revision = await resolveRevision(odb, refs, segments)
  if (!revision) return { kind: 'not-found', message: 'unknown ref' }
  if (allowed && !(await allowed(revision.commit, revision.path))) return { kind: 'not-found', message: 'path not found' }
  const entry = await resolvePath(odb, revision.commit, revision.path)
  if (!entry) return { kind: 'not-found', message: 'path not found' }
  const blob = await odb.read(entry.id)
  if (!blob || blob.type !== 'blob') return { kind: 'not-found', message: 'path not found' }
  const pointer = entry.mode === '120000' ? null : parseLfsPointer(blob.data)
  if (pointer) return { kind: 'lfs', pointer, name: entry.name, immutable: revision.immutable }
  return { kind: 'blob', id: entry.id, data: blob.data, name: entry.name, immutable: revision.immutable }
}

export type RangeRequest = { readonly kind: 'full' } | { readonly kind: 'partial'; readonly range: ByteRange } | { readonly kind: 'unsatisfiable' }

const FULL: RangeRequest = { kind: 'full' }

export const parseRange = (header: string | null, size: number): RangeRequest => {
  if (header === null) return FULL
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!match) return FULL
  const [, startText, endText] = match as unknown as [string, string, string]
  if (startText === '' && endText === '') return FULL
  if (startText === '') {
    const suffix = Number(endText)
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' }
    const length = Math.min(suffix, size)
    return { kind: 'partial', range: { offset: size - length, length } }
  }
  const start = Number(startText)
  const end = endText === '' ? size - 1 : Number(endText)
  if (endText !== '' && end < start) return FULL
  if (start >= size) return { kind: 'unsatisfiable' }
  return { kind: 'partial', range: { offset: start, length: Math.min(end, size - 1) - start + 1 } }
}

const entityTags = (header: string): string[] => header.split(',').map((tag) => tag.trim().replace(/^W\//, ''))

export const matchesNoneMatch = (header: string | null, etag: string): boolean => {
  if (header === null) return false
  if (header.trim() === '*') return true
  return entityTags(header).includes(`"${etag}"`)
}

export const rangeApplies = (ifRange: string | null, etag: string): boolean => ifRange === null || ifRange.trim() === `"${etag}"`

const TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  json: 'application/json',
  geojson: 'application/geo+json',
  xml: 'application/xml',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
}

export const TEXT_PLAIN = 'text/plain; charset=utf-8'

export const OCTET_STREAM = 'application/octet-stream'

export const contentTypeForName = (name: string): string | null => {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? null : (TYPES[name.slice(dot + 1).toLowerCase()] ?? null)
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  bytes.length >= at + prefix.length && prefix.every((byte, i) => bytes[at + i] === byte)

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))

const asciiAt = (bytes: Uint8Array, at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length))

export const SNIFF_BYTES = 64

export const sniffContentType = (bytes: Uint8Array): string | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WAVE'), 8)) return 'audio/wav'
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf'
  if (startsWith(bytes, ascii('ftyp'), 4)) {
    const brand = asciiAt(bytes, 8, 4)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic'
    if (brand === 'qt  ') return 'video/quicktime'
    if (brand === 'M4A ') return 'audio/mp4'
    return 'video/mp4'
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return asciiAt(bytes, 0, bytes.length).includes('webm') ? 'video/webm' : 'video/x-matroska'
  if (startsWith(bytes, ascii('OggS'))) return 'audio/ogg'
  if (startsWith(bytes, ascii('fLaC'))) return 'audio/flac'
  if (startsWith(bytes, ascii('ID3')) || startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3]) || startsWith(bytes, [0xff, 0xf2])) return 'audio/mpeg'
  if (startsWith(bytes, ascii('II*\0')) || startsWith(bytes, ascii('MM\0*'))) return 'image/tiff'
  if (startsWith(bytes, ascii('wOF2'))) return 'font/woff2'
  if (startsWith(bytes, ascii('wOFF'))) return 'font/woff'
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip'
  if (startsWith(bytes, [0x1f, 0x8b])) return 'application/gzip'
  return null
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

export const looksLikeText = (bytes: Uint8Array): boolean => {
  const sample = bytes.subarray(0, 8000)
  if (sample.includes(0)) return false
  try {
    strictUtf8.decode(bytes)
    return true
  } catch {
    return false
  }
}

export const blobContentType = (name: string, data: Uint8Array): string =>
  contentTypeForName(name) ?? sniffContentType(data.subarray(0, SNIFF_BYTES)) ?? (looksLikeText(data) ? TEXT_PLAIN : OCTET_STREAM)

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'

export const refCacheControl = (immutable: boolean, maxAge: number): string => (immutable ? IMMUTABLE_CACHE : `public, max-age=${maxAge}`)

export const contentDisposition = (filename: string, disposition: 'inline' | 'attachment' = 'inline'): string => {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export const SANDBOX_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
}

export const safetyHeaders = (contentType: string): Record<string, string> =>
  contentType === 'application/pdf' ? { 'X-Content-Type-Options': 'nosniff' } : { ...SANDBOX_HEADERS }

export const downloadHeaders = (filename: string | null): Record<string, string> => ({
  ...SANDBOX_HEADERS,
  'Content-Disposition': filename ? contentDisposition(filename, 'attachment') : 'attachment',
})

export const mediaPath = (repo: RepositoryName, oid: string, filename?: string): string =>
  `/${repo.owner}/${repo.name}/media/${oid}${filename ? `/${encodeURIComponent(filename)}` : ''}`
