import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { utf8 } from '../src/bytes.ts'
import {
  blobContentType,
  contentDisposition,
  contentTypeForName,
  matchContentRoute,
  matchesNoneMatch,
  parseRange,
  rangeApplies,
  refCacheControl,
  sniffContentType,
} from '../src/content.ts'
import { handleContentRequest } from '../src/content-http.ts'
import { sha256Hex } from '../src/hash.ts'
import { type Authorize, handleGitRequest } from '../src/http.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { createRepository } from '../src/repository.ts'
import { gitEnv, tempDir, writeFile } from './git-helpers.ts'
import { type RunningServer, startServer } from './http-server.ts'

const run = promisify(execFile)

describe('content routes', () => {
  const oid = 'a'.repeat(64)

  it('matches media URLs with and without a file name', () => {
    expect(matchContentRoute(`/acme/site/media/${oid}`)).toEqual({ kind: 'media', repo: { owner: 'acme', name: 'site' }, oid, filename: null })
    expect(matchContentRoute(`/acme/site/media/${oid}/H%C3%B6he%20Foto.jpg`)).toMatchObject({ filename: 'Höhe Foto.jpg' })
    expect(matchContentRoute(`/acme/site/media/${'A'.repeat(64)}`)).toBeNull()
    expect(matchContentRoute(`/acme/site/media/${oid}/a/b`)).toBeNull()
    expect(matchContentRoute('/acme/site/media/abc')).toBeNull()
  })

  it('matches raw URLs and rejects traversal and git paths', () => {
    expect(matchContentRoute('/acme/site/raw/main/docs/a%20b.md')).toEqual({
      kind: 'raw',
      repo: { owner: 'acme', name: 'site' },
      segments: ['main', 'docs', 'a b.md'],
    })
    expect(matchContentRoute('/acme/site/raw/main')).toBeNull()
    expect(matchContentRoute('/acme/site/raw/main/../x')).toBeNull()
    expect(matchContentRoute('/acme/site/raw/main/a%2Fb')).toBeNull()
    expect(matchContentRoute('/acme/site/raw/main//x')).toBeNull()
    expect(matchContentRoute('/acme/site/raw/main/%E0%A4%A')).toBeNull()
    expect(matchContentRoute('/acme/site.git/raw/main/x')).toBeNull()
    expect(matchContentRoute('/acme/site/info/refs')).toBeNull()
  })
})

describe('range requests', () => {
  it('parses single byte ranges', () => {
    expect(parseRange(null, 100)).toEqual({ kind: 'full' })
    expect(parseRange('bytes=0-9', 100)).toEqual({ kind: 'partial', range: { offset: 0, length: 10 } })
    expect(parseRange('bytes=90-', 100)).toEqual({ kind: 'partial', range: { offset: 90, length: 10 } })
    expect(parseRange('bytes=95-200', 100)).toEqual({ kind: 'partial', range: { offset: 95, length: 5 } })
    expect(parseRange('bytes=-30', 100)).toEqual({ kind: 'partial', range: { offset: 70, length: 30 } })
    expect(parseRange('bytes=-300', 100)).toEqual({ kind: 'partial', range: { offset: 0, length: 100 } })
  })

  it('ignores what it cannot serve and reports unsatisfiable ranges', () => {
    expect(parseRange('bytes=0-1,5-6', 100)).toEqual({ kind: 'full' })
    expect(parseRange('items=0-1', 100)).toEqual({ kind: 'full' })
    expect(parseRange('bytes=9-3', 100)).toEqual({ kind: 'full' })
    expect(parseRange('bytes=-', 100)).toEqual({ kind: 'full' })
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
  })

  it('evaluates If-None-Match and If-Range', () => {
    expect(matchesNoneMatch('"abc"', 'abc')).toBe(true)
    expect(matchesNoneMatch('"x", W/"abc"', 'abc')).toBe(true)
    expect(matchesNoneMatch('*', 'abc')).toBe(true)
    expect(matchesNoneMatch('"abd"', 'abc')).toBe(false)
    expect(matchesNoneMatch(null, 'abc')).toBe(false)
    expect(rangeApplies(null, 'abc')).toBe(true)
    expect(rangeApplies('"abc"', 'abc')).toBe(true)
    expect(rangeApplies('"old"', 'abc')).toBe(false)
  })
})

describe('content types', () => {
  it('maps file names and never serves HTML as HTML', () => {
    expect(contentTypeForName('Photo.JPG')).toBe('image/jpeg')
    expect(contentTypeForName('clip.mp4')).toBe('video/mp4')
    expect(contentTypeForName('index.html')).toBeNull()
    expect(contentTypeForName('.png')).toBeNull()
    expect(blobContentType('index.html', utf8('<script>alert(1)</script>'))).toBe('text/plain; charset=utf-8')
    expect(blobContentType('LICENSE', utf8('MIT'))).toBe('text/plain; charset=utf-8')
    expect(blobContentType('data', new Uint8Array([0, 1, 2, 0xff]))).toBe('application/octet-stream')
  })

  it('sniffs common media formats', () => {
    const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap((part) => (typeof part === 'string' ? [...utf8(part)] : part)))
    expect(sniffContentType(bytes([0x89], 'PNG\r\n', [0x1a, 0x0a, 0]))).toBe('image/png')
    expect(sniffContentType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffContentType(bytes('GIF89a'))).toBe('image/gif')
    expect(sniffContentType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp')
    expect(sniffContentType(bytes('%PDF-1.7'))).toBe('application/pdf')
    expect(sniffContentType(bytes([0, 0, 0, 0x18], 'ftypisom'))).toBe('video/mp4')
    expect(sniffContentType(bytes([0, 0, 0, 0x18], 'ftypqt  '))).toBe('video/quicktime')
    expect(sniffContentType(bytes([0x1a, 0x45, 0xdf, 0xa3], 'B\x82webm'))).toBe('video/webm')
    expect(sniffContentType(bytes('ID3', [4, 0]))).toBe('audio/mpeg')
    expect(sniffContentType(bytes('hello'))).toBeNull()
  })

  it('builds cache and disposition headers', () => {
    expect(refCacheControl(true, 60)).toBe('public, max-age=31536000, immutable')
    expect(refCacheControl(false, 60)).toBe('public, max-age=60')
    expect(contentDisposition('Höhe "1".jpg')).toBe(`inline; filename="H_he _1_.jpg"; filename*=UTF-8''H%C3%B6he%20%221%22.jpg`)
  })
})

const lfsFilterConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
] as const

const env = {
  ...process.env,
  ...gitEnv,
  GIT_CONFIG_COUNT: String(lfsFilterConfig.length),
  ...Object.fromEntries(lfsFilterConfig.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
}

const git = async (cwd: string, args: readonly string[]): Promise<string> => (await run('git', args, { cwd, env })).stdout

const READER = `Bearer reader-token`
const WRITER = `Basic ${btoa('writer:secret')}`

const authorize: Authorize = async (request, repo, access) => {
  const authorization = request.headers.get('Authorization')
  if (authorization === WRITER) return null
  if (access === 'read' && (repo.name === 'public' || authorization === READER)) return null
  return new Response('authentication required\n', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="git-forge"' } })
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 200_000 }, (_, i) => (i * 7) % 251)])
const pngOid = sha256Hex(png)
const video = new Uint8Array([0, 0, 0, 0x18, ...utf8('ftypisom'), ...Array.from({ length: 50_000 }, (_, i) => i % 256)])
const videoOid = sha256Hex(video)

let storage: MemoryStorage
let server: RunningServer
let commit: string

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => fetch(`${server.url}${path}`, { method, headers, redirect: 'manual' })

beforeAll(async () => {
  storage = new MemoryStorage()
  server = await startServer(
    async (request) =>
      (await handleContentRequest(request, { storage, authorize })) ??
      (await handleGitRequest(request, { storage, authorize })) ??
      new Response('not found', { status: 404 }),
  )
  for (const name of ['public', 'private']) await createRepository(storage, { owner: 'acme', name })
  const dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  await git(dir, ['lfs', 'install', '--local'])
  await git(dir, ['config', 'lfs.locksverify', 'false'])
  await git(dir, ['lfs', 'track', '*.png', '*.mp4'])
  writeFile(dir, 'photos/logo.png', png)
  writeFile(dir, 'clip.mp4', video)
  writeFile(dir, 'docs/read me.md', '# Hello\n')
  writeFile(dir, 'index.html', '<script>alert(1)</script>\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'first'])
  commit = (await git(dir, ['rev-parse', 'HEAD'])).trim()
  await git(dir, ['tag', '-a', 'v1', '-m', 'v1'])
  writeFile(dir, 'docs/read me.md', '# Hello again\n')
  await git(dir, ['commit', '-q', '-am', 'second'])
  await git(dir, ['branch', 'feature/new-look'])
  for (const name of ['public', 'private']) {
    const remote = `${server.url.replace('://', '://writer:secret@')}/acme/${name}.git`
    await git(dir, ['push', '-q', remote, 'main', 'feature/new-look', 'v1'])
  }
}, 60_000)

afterAll(async () => {
  await server.close()
})

describe('media endpoint', () => {
  it('serves an LFS object as immutable with a strong ETag and a sniffed type', async () => {
    const response = await get(`/acme/public/media/${pngOid}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('ETag')).toBe(`"${pngOid}"`)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Content-Length')).toBe(String(png.length))
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png)
  })

  it('takes the type from a trailing file name', async () => {
    const response = await get(`/acme/public/media/${videoOid}/clip.mp4`)
    expect(response.headers.get('Content-Type')).toBe('video/mp4')
    expect(response.headers.get('Content-Disposition')).toBe(`inline; filename="clip.mp4"; filename*=UTF-8''clip.mp4`)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(video)
  })

  it('answers range, HEAD and conditional requests', async () => {
    const partial = await get(`/acme/public/media/${pngOid}`, { Range: 'bytes=100-199' })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('Content-Range')).toBe(`bytes 100-199/${png.length}`)
    expect(partial.headers.get('Content-Length')).toBe('100')
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(png.slice(100, 200))

    const suffix = await get(`/acme/public/media/${pngOid}`, { Range: 'bytes=-10' })
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(png.slice(-10))

    const outside = await get(`/acme/public/media/${pngOid}`, { Range: `bytes=${png.length}-` })
    expect(outside.status).toBe(416)
    expect(outside.headers.get('Content-Range')).toBe(`bytes */${png.length}`)

    const stale = await get(`/acme/public/media/${pngOid}`, { Range: 'bytes=0-9', 'If-Range': '"other"' })
    expect(stale.status).toBe(200)
    await stale.arrayBuffer()

    const head = await get(`/acme/public/media/${pngOid}`, {}, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Length')).toBe(String(png.length))
    expect(head.headers.get('Content-Type')).toBe('image/png')

    const cached = await get(`/acme/public/media/${pngOid}`, { 'If-None-Match': `"${pngOid}"` })
    expect(cached.status).toBe(304)
    expect(cached.headers.get('ETag')).toBe(`"${pngOid}"`)
  })

  it('answers 404 for unknown objects and repositories and 405 for writes', async () => {
    expect((await get(`/acme/public/media/${'0'.repeat(64)}`)).status).toBe(404)
    expect((await get(`/acme/nothing/media/${pngOid}`, { Authorization: READER })).status).toBe(404)
    expect((await fetch(`${server.url}/acme/public/media/${pngOid}`, { method: 'PUT', body: 'x' })).status).toBe(405)
  })

  it('requires a read token for private repositories', async () => {
    expect((await get(`/acme/private/media/${pngOid}`)).status).toBe(401)
    expect((await get(`/acme/private/media/${pngOid}`, { Authorization: 'Bearer wrong' })).status).toBe(401)
    const response = await get(`/acme/private/media/${pngOid}`, { Authorization: READER })
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png)
  })
})

describe('raw endpoint', () => {
  it('streams a blob from a branch with a short cache', async () => {
    const response = await get('/acme/public/raw/main/docs/read%20me.md')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('# Hello again\n')
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(response.headers.get('ETag')).toMatch(/^"[0-9a-f]{40}"$/)
  })

  it('serves immutable content for full commit ids and resolves tags and branches with slashes', async () => {
    const pinned = await get(`/acme/public/raw/${commit}/docs/read%20me.md`)
    expect(await pinned.text()).toBe('# Hello\n')
    expect(pinned.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(await (await get('/acme/public/raw/v1/docs/read%20me.md')).text()).toBe('# Hello\n')
    expect(await (await get('/acme/public/raw/feature/new-look/docs/read%20me.md')).text()).toBe('# Hello again\n')
    expect(await (await get('/acme/public/raw/HEAD/docs/read%20me.md')).text()).toBe('# Hello again\n')
  })

  it('serves HTML as plain text in a sandbox', async () => {
    const response = await get('/acme/public/raw/main/index.html')
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
  })

  it('redirects LFS pointers to the media URL with the file name', async () => {
    const response = await get('/acme/public/raw/main/photos/logo.png')
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(`/acme/public/media/${pngOid}/logo.png`)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60')
    const pinned = await get(`/acme/public/raw/${commit}/clip.mp4`)
    expect(pinned.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    const followed = await fetch(`${server.url}/acme/public/raw/main/photos/logo.png`)
    expect(followed.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await followed.arrayBuffer())).toEqual(png)
  })

  it('supports ranges on plain blobs', async () => {
    const response = await get('/acme/public/raw/main/docs/read%20me.md', { Range: 'bytes=2-6' })
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('Hello')
  })

  it('answers 404 for unknown refs, paths, directories and abbreviated ids', async () => {
    for (const path of ['nope/docs/read%20me.md', 'main/docs/missing.md', 'main/docs', `${commit.slice(0, 12)}/clip.mp4`, `${'f'.repeat(40)}/clip.mp4`]) {
      expect((await get(`/acme/public/raw/${path}`)).status, path).toBe(404)
    }
  })

  it('requires a read token for private repositories', async () => {
    expect((await get('/acme/private/raw/main/docs/read%20me.md')).status).toBe(401)
    const response = await get('/acme/private/raw/main/docs/read%20me.md', { Authorization: READER })
    expect(await response.text()).toBe('# Hello again\n')
  })
})
