import { concat, readAll, utf8 } from './bytes.ts'
import { crc32, type ObjectId } from './hash.ts'
import type { Authorize } from './http.ts'
import { isTreeMode, parseCommit, parseTree } from './objects.ts'
import { isValidName, ObjectDatabase, readRefs, type RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'
import { commitTarball, gzipStream, resolveCommitish } from './tarball.ts'
import { commitReach } from './visibility.ts'

type ArchiveEntry = { readonly path: string; readonly kind: 'directory' | 'file' | 'symlink'; readonly mode: number; readonly data: Uint8Array }

const walk = async function* (odb: ObjectDatabase, tree: ObjectId, path: string): AsyncGenerator<ArchiveEntry> {
  const object = await odb.read(tree)
  if (!object || object.type !== 'tree') throw new Error(`missing tree ${tree}`)
  for (const entry of parseTree(object.data)) {
    const full = `${path}${entry.name}`
    if (isTreeMode(entry.mode)) {
      yield { path: `${full}/`, kind: 'directory', mode: 0o40755, data: new Uint8Array() }
      yield* walk(odb, entry.id, `${full}/`)
      continue
    }
    if (entry.mode === '160000') {
      yield { path: `${full}/`, kind: 'directory', mode: 0o40755, data: new Uint8Array() }
      continue
    }
    const blob = await odb.read(entry.id)
    if (!blob || blob.type !== 'blob') throw new Error(`missing blob ${entry.id}`)
    yield entry.mode === '120000'
      ? { path: full, kind: 'symlink', mode: 0o120777, data: blob.data }
      : { path: full, kind: 'file', mode: entry.mode === '100755' ? 0o100755 : 0o100644, data: blob.data }
  }
}

const deflateRaw = async (data: Uint8Array): Promise<Uint8Array> =>
  readAll(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>))

const record = (size: number, write: (view: DataView) => void): Uint8Array => {
  const bytes = new Uint8Array(size)
  write(new DataView(bytes.buffer))
  return bytes
}

const dosTime = (seconds: number): { readonly time: number; readonly date: number } => {
  const at = new Date(Math.max(seconds, 315532800) * 1000)
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  }
}

type CentralEntry = { readonly name: Uint8Array; readonly method: number; readonly crc: number; readonly compressed: number; readonly size: number; readonly offset: number; readonly mode: number; readonly kind: ArchiveEntry['kind'] }

export const commitZip = (odb: ObjectDatabase, commitId: ObjectId, options: { readonly prefix: string }): ReadableStream<Uint8Array> => {
  const prefix = options.prefix.replace(/\/*$/, '/')
  const central: CentralEntry[] = []
  let entries: AsyncGenerator<ArchiveEntry> | undefined
  let offset = 0
  let stamp = { time: 0, date: 0 }
  let extra: Uint8Array = new Uint8Array()
  const flags = (name: string) => (/[^\x20-\x7e]/.test(name) ? 0x0800 : 0)
  const emit = async (entry: ArchiveEntry): Promise<Uint8Array> => {
    const name = utf8(entry.path)
    const deflated = entry.kind === 'file' && entry.data.length > 0 ? await deflateRaw(entry.data) : null
    const method = deflated && deflated.length < entry.data.length ? 8 : 0
    const body = method === 8 ? deflated! : entry.data
    const crc = crc32(entry.data)
    const header = record(30, (view) => {
      view.setUint32(0, 0x04034b50, true)
      view.setUint16(4, method === 8 ? 20 : 10, true)
      view.setUint16(6, flags(entry.path), true)
      view.setUint16(8, method, true)
      view.setUint16(10, stamp.time, true)
      view.setUint16(12, stamp.date, true)
      view.setUint32(14, crc, true)
      view.setUint32(18, body.length, true)
      view.setUint32(22, entry.data.length, true)
      view.setUint16(26, name.length, true)
      view.setUint16(28, extra.length, true)
    })
    central.push({ name, method, crc, compressed: body.length, size: entry.data.length, offset, mode: entry.mode, kind: entry.kind })
    const out = concat([header, name, extra, body])
    offset += out.length
    return out
  }
  const directory = (comment: Uint8Array): Uint8Array => {
    const parts = central.map((entry) =>
      concat([
        record(46, (view) => {
          const unix = entry.kind === 'symlink' || (entry.kind === 'file' && (entry.mode & 0o111) !== 0)
          view.setUint32(0, 0x02014b50, true)
          view.setUint16(4, unix ? 0x0317 : 0, true)
          view.setUint16(6, entry.method === 8 ? 20 : 10, true)
          view.setUint16(8, flags(new TextDecoder().decode(entry.name)), true)
          view.setUint16(10, entry.method, true)
          view.setUint16(12, stamp.time, true)
          view.setUint16(14, stamp.date, true)
          view.setUint32(16, entry.crc, true)
          view.setUint32(20, entry.compressed, true)
          view.setUint32(24, entry.size, true)
          view.setUint16(28, entry.name.length, true)
          view.setUint16(30, extra.length, true)
          view.setUint32(38, entry.kind === 'directory' ? 0x10 : unix ? ((entry.kind === 'symlink' ? 0o120777 : entry.mode) << 16) >>> 0 : 0, true)
          view.setUint32(42, entry.offset, true)
        }),
        entry.name,
        extra,
      ]),
    )
    const body = concat(parts)
    const end = record(22, (view) => {
      view.setUint32(0, 0x06054b50, true)
      view.setUint16(8, central.length, true)
      view.setUint16(10, central.length, true)
      view.setUint32(12, body.length, true)
      view.setUint32(16, offset, true)
      view.setUint16(20, comment.length, true)
    })
    return concat([body, end, comment])
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!entries) {
        const commit = await odb.read(commitId)
        if (!commit || commit.type !== 'commit') throw new Error(`${commitId} is not a commit`)
        const mtime = Number(/^committer .* (\d+) [+-]\d{4}$/m.exec(new TextDecoder().decode(commit.data).split('\n\n')[0] ?? '')?.[1] ?? 0)
        stamp = dosTime(mtime)
        extra = record(9, (view) => {
          view.setUint16(0, 0x5455, true)
          view.setUint16(2, 5, true)
          view.setUint8(4, 1)
          view.setUint32(5, mtime, true)
        })
        entries = walk(odb, parseCommit(commit.data).tree, prefix)
        controller.enqueue(await emit({ path: prefix, kind: 'directory', mode: 0o40755, data: new Uint8Array() }))
        return
      }
      const next = await entries.next()
      if (next.done) {
        controller.enqueue(directory(utf8(commitId)))
        controller.close()
        return
      }
      controller.enqueue(await emit(next.value))
    },
  })
}

export type ArchiveFormat = 'tar.gz' | 'zip'

export const archiveResponse = (odb: ObjectDatabase, commit: ObjectId, format: ArchiveFormat, prefix: string, cacheControl: string): Response =>
  new Response(format === 'zip' ? commitZip(odb, commit, { prefix }) : gzipStream(commitTarball(odb, commit, { prefix })), {
    headers: {
      'Content-Type': format === 'zip' ? 'application/zip' : 'application/x-gzip',
      'Content-Disposition': `attachment; filename=${prefix}.${format}`,
      'Cache-Control': cacheControl,
      ETag: `"${commit}-${format}"`,
    },
  })

const ARCHIVE = /^\/([^/]+)\/([^/]+)\/archive\/(.+)\.(tar\.gz|zip)$/

const BALL = /^\/api(?:\/v3)?\/repos\/([^/]+)\/([^/]+)\/(tarball|zipball)(?:\/(.+))?$/

export const archivePrefix = (repo: string, ref: string): string => `${repo}-${ref.replace(/^refs\/(heads|tags)\//, '').replace(/^v(?=\d)/, '').replace(/\//g, '-')}`

const text = (status: number, body: string) => new Response(`${body}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })

export const handleArchiveRequest = async (request: Request, options: { readonly storage: Storage; readonly authorize?: Authorize }): Promise<Response | null> => {
  const { pathname } = new URL(request.url)
  const archive = ARCHIVE.exec(pathname)
  const ball = archive ? null : BALL.exec(pathname)
  const match = archive ?? ball
  if (!match) return null
  const [owner, name] = [decodeURIComponent(match[1]!), decodeURIComponent(match[2]!)]
  if (!isValidName(owner) || !isValidName(name)) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed')
  const repo: RepositoryName = { owner, name }
  const view = await options.authorize?.(request, repo, 'read', 'git')
  if (view instanceof Response) return view
  const refs = await readRefs(options.storage, repo)
  if (!refs) return text(404, 'repository not found')
  const ref = match[archive ? 3 : 4] ? decodeURIComponent(match[archive ? 3 : 4]!) : refs.state.head
  const commit = await resolveCommitish(options.storage, repo, ref)
  if (!commit) return text(404, 'not found')
  const odb = new ObjectDatabase(options.storage, repo)
  if (view && (await commitReach(odb, refs.state, view, commit))?.('') !== 'inside') return text(404, 'not found')
  const format: ArchiveFormat = archive ? (match[4] as ArchiveFormat) : match[3] === 'zipball' ? 'zip' : 'tar.gz'
  const prefix = archive ? archivePrefix(name, ref.toLowerCase() === commit ? commit : ref) : `${owner}-${name}-${commit.slice(0, 7)}`
  const immutable = commit === ref.toLowerCase()
  const response = archiveResponse(odb, commit, format, prefix, view ? 'private, max-age=60' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60')
  return request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response
}
