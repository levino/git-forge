import { contentTypeForName, isLfsOid, OCTET_STREAM, type RepositoryName, repositoryPrefix, sha256Hex, utf8 } from '@git-forge/core'

export type ManifestEntry = {
  readonly oid: string
  readonly size: number
  readonly lfs?: true
}

export type Manifest = {
  readonly version: 1
  readonly files: Readonly<Record<string, ManifestEntry>>
}

export class ManifestError extends Error {}

export const MANIFEST_VERSION = 1

export const manifestKey = (repo: RepositoryName, oid: string): string => `${repositoryPrefix(repo)}pages/deployments/${oid}.json`

export const normalizeSitePath = (path: string): string | null => {
  const segments = path.replace(/\\/g, '/').split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..' || segment.includes('\0'))) return null
  return segments.join('/')
}

export const serializeManifest = (files: ReadonlyMap<string, ManifestEntry>): { readonly bytes: Uint8Array; readonly oid: string } => {
  const sorted: Record<string, ManifestEntry> = {}
  for (const path of [...files.keys()].sort()) {
    const entry = files.get(path)!
    sorted[path] = entry.lfs ? { oid: entry.oid, size: entry.size, lfs: true } : { oid: entry.oid, size: entry.size }
  }
  const bytes = utf8(JSON.stringify({ version: MANIFEST_VERSION, files: sorted }))
  return { bytes, oid: sha256Hex(bytes) }
}

export const parseManifest = (text: string): Manifest => {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== MANIFEST_VERSION) throw new ManifestError('unsupported manifest version')
  const files = (value as { files?: unknown }).files
  if (typeof files !== 'object' || files === null) throw new ManifestError('manifest without files')
  for (const entry of Object.values(files)) {
    const { oid, size } = entry as Partial<ManifestEntry>
    if (!isLfsOid(oid) || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new ManifestError('invalid manifest entry')
  }
  return value as Manifest
}

export type PagesResolution =
  | { readonly kind: 'file'; readonly path: string; readonly entry: ManifestEntry }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'not-found'; readonly page: { readonly path: string; readonly entry: ManifestEntry } | null }

const decode = (pathname: string): string | null => {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return null
  }
}

export const resolvePagesPath = (manifest: Manifest, pathname: string): PagesResolution => {
  const files = manifest.files
  const notFound: PagesResolution = { kind: 'not-found', page: files['404.html'] ? { path: '404.html', entry: files['404.html'] } : null }
  const decoded = decode(pathname)
  if (decoded === null) return notFound
  const directory = decoded === '' || decoded.endsWith('/')
  const normalized = normalizeSitePath(decoded)
  if (normalized === null) {
    if (decoded.split('/').includes('..')) return notFound
    return files['index.html'] ? { kind: 'file', path: 'index.html', entry: files['index.html'] } : notFound
  }
  if (!directory && files[normalized]) return { kind: 'file', path: normalized, entry: files[normalized] }
  const index = `${normalized}/index.html`
  if (files[index]) return directory ? { kind: 'file', path: index, entry: files[index] } : { kind: 'redirect', location: `${normalized.split('/').pop()!}/` }
  if (!directory && files[`${normalized}.html`]) return { kind: 'file', path: `${normalized}.html`, entry: files[`${normalized}.html`]! }
  return notFound
}

const PAGE_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  webmanifest: 'application/manifest+json',
  map: 'application/json',
  rss: 'application/rss+xml',
  atom: 'application/atom+xml',
  xml: 'application/xml; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
}

export const pagesContentType = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return PAGE_TYPES[extension] ?? contentTypeForName(name) ?? OCTET_STREAM
}
