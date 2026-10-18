import { base64UrlEncode, type Database, first, randomBytes, sha256Hex, sql } from '@git-forge/accounts'
import { type ByteRange, contentDisposition, exactLength, parseRange, readAll, type Storage } from '@git-forge/core'

export type BlobRow = {
  readonly id: string
  readonly owner: string
  readonly repo: string
  readonly prefix: string
  readonly content_type: string | null
  readonly size: number | null
  readonly created_at: number
  readonly committed_at: number | null
}

export type BlobPart = {
  readonly idx: number
  readonly offset: number
  readonly size: number
  readonly key: string
}

export type StagedBlock = {
  readonly block_id: string
  readonly key: string
  readonly size: number
}

export type BlobGrant = {
  readonly blob_id: string
  readonly access: 'read' | 'write'
  readonly job_id: string | null
  readonly filename: string | null
  readonly expires_at: number
}

export const BLOB_PATH = '/_services/results/blobs/'

export const MAX_UNSIZED_BLOCK_BYTES = 16 * 1024 * 1024

export const MAX_BLOCK_ID_LENGTH = 128

export class BlobError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const createBlob = async (db: Database, blob: { readonly owner: string; readonly repo: string; readonly prefix: string; readonly contentType: string | null }, now: number): Promise<BlobRow> => {
  const id = crypto.randomUUID()
  const prefix = `${blob.prefix}${id}/`
  await db.run(sql('INSERT INTO actions_blobs (id, owner, repo, prefix, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, blob.owner, blob.repo, prefix, blob.contentType, now))
  return (await getBlob(db, id))!
}

export const getBlob = async (db: Database, id: string): Promise<BlobRow | null> => first<BlobRow>(db, sql('SELECT * FROM actions_blobs WHERE id = ?', id))

export const issueBlobGrant = async (
  db: Database,
  grant: { readonly blobId: string; readonly access: 'read' | 'write'; readonly jobId: string | null; readonly filename?: string | null; readonly ttlMs: number },
  now: number,
): Promise<string> => {
  const token = base64UrlEncode(randomBytes(32))
  await db.run(
    sql(
      'INSERT INTO actions_blob_grants (hash, blob_id, access, job_id, filename, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      await sha256Hex(token),
      grant.blobId,
      grant.access,
      grant.jobId,
      grant.filename ?? null,
      now + grant.ttlMs,
    ),
  )
  return token
}

export const blobUrl = (serverUrl: string, token: string, filename?: string): string => `${serverUrl}${BLOB_PATH}${token}${filename ? `/${encodeURIComponent(filename)}` : ''}`

export const verifyBlobGrant = async (db: Database, token: string, now: number): Promise<BlobGrant | null> => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  const grant = await first<BlobGrant>(db, sql('SELECT blob_id, access, job_id, filename, expires_at FROM actions_blob_grants WHERE hash = ?', await sha256Hex(token)))
  return grant && grant.expires_at > now ? grant : null
}

export const blockKey = (blob: BlobRow): string => `${blob.prefix}blocks/${crypto.randomUUID()}`

const sizedBody = async (body: ReadableStream<Uint8Array> | null, size: number | null): Promise<{ readonly body: Uint8Array | ReadableStream<Uint8Array>; readonly size: number }> => {
  if (!body) return { body: new Uint8Array(0), size: size ?? 0 }
  if (size !== null) return { body: body.pipeThrough(exactLength(size)), size }
  const bytes = await readAll(body, MAX_UNSIZED_BLOCK_BYTES)
  return { body: bytes, size: bytes.length }
}

export const stageBlock = async (
  db: Database,
  storage: Storage,
  blob: BlobRow,
  blockId: string,
  body: ReadableStream<Uint8Array> | null,
  size: number | null,
  now: number,
): Promise<StagedBlock> => {
  if (blob.committed_at !== null) throw new BlobError(409, 'BlobImmutable', 'the blob is already committed')
  if (blockId.length === 0 || blockId.length > MAX_BLOCK_ID_LENGTH) throw new BlobError(400, 'InvalidQueryParameterValue', 'invalid block id')
  const sized = await sizedBody(body, size)
  const key = blockKey(blob)
  const stored = await storage.put(key, sized.body, sized.size, { ifNoneMatch: '*' })
  if (!stored.ok) throw new BlobError(409, 'BlockConflict', 'block key already exists')
  await db.run(
    sql(
      'INSERT INTO actions_blob_blocks (blob_id, block_id, key, size, staged_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (blob_id, block_id) DO UPDATE SET key = excluded.key, size = excluded.size, staged_at = excluded.staged_at',
      blob.id,
      blockId,
      key,
      sized.size,
      now,
    ),
  )
  return { block_id: blockId, key, size: sized.size }
}

export const stagedBlocks = async (db: Database, blobId: string): Promise<StagedBlock[]> =>
  db.all<StagedBlock>(sql('SELECT block_id, key, size FROM actions_blob_blocks WHERE blob_id = ?', blobId))

export const planParts = (order: readonly string[], staged: readonly StagedBlock[]): BlobPart[] => {
  const byId = new Map(staged.map((block) => [block.block_id, block]))
  let offset = 0
  return order.map((blockId, idx) => {
    const block = byId.get(blockId)
    if (!block) throw new BlobError(400, 'InvalidBlockList', `block ${blockId} was not staged`)
    const part = { idx, offset, size: block.size, key: block.key }
    offset += block.size
    return part
  })
}

export const RANGE_BLOCK_PREFIX = 'range:'

export const rangeBlockId = (start: number, end: number): string => `${RANGE_BLOCK_PREFIX}${start}-${end}`

export const planRangeParts = (staged: readonly StagedBlock[], size: number): BlobPart[] => {
  const ranges = staged
    .flatMap((block) => {
      const match = /^range:(\d+)-(\d+)$/.exec(block.block_id)
      return match ? [{ start: Number(match[1]), end: Number(match[2]), block }] : []
    })
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const parts: BlobPart[] = []
  let offset = 0
  for (const range of ranges) {
    if (offset >= size) break
    if (range.start !== offset) {
      if (range.start < offset) continue
      throw new BlobError(400, 'IncompleteUpload', `missing bytes ${offset}-${range.start - 1}`)
    }
    parts.push({ idx: parts.length, offset, size: range.block.size, key: range.block.key })
    offset += range.block.size
  }
  if (offset !== size) throw new BlobError(400, 'IncompleteUpload', `uploaded ${offset} of ${size} bytes`)
  return parts
}

export const commitParts = async (db: Database, blob: BlobRow, parts: readonly BlobPart[], now: number): Promise<BlobRow> => {
  const size = parts.reduce((total, part) => total + part.size, 0)
  const { changes } = await db.run(sql('UPDATE actions_blobs SET size = ?, committed_at = ? WHERE id = ? AND committed_at IS NULL', size, now, blob.id))
  if (changes !== 1) throw new BlobError(409, 'BlobImmutable', 'the blob is already committed')
  if (parts.length > 0) {
    await db.batch(parts.map((part) => sql('INSERT INTO actions_blob_parts (blob_id, idx, offset, size, key) VALUES (?, ?, ?, ?, ?)', blob.id, part.idx, part.offset, part.size, part.key)))
  }
  return (await getBlob(db, blob.id))!
}

export const commitBlockList = async (db: Database, blob: BlobRow, order: readonly string[], now: number): Promise<BlobRow> =>
  commitParts(db, blob, planParts(order, await stagedBlocks(db, blob.id)), now)

export const commitRanges = async (db: Database, blob: BlobRow, size: number, now: number): Promise<BlobRow> =>
  commitParts(db, blob, planRangeParts(await stagedBlocks(db, blob.id), size), now)

export const partsInRange = async (db: Database, blobId: string, range: ByteRange): Promise<BlobPart[]> =>
  db.all<BlobPart>(
    sql('SELECT idx, offset, size, key FROM actions_blob_parts WHERE blob_id = ? AND offset + size > ? AND offset < ? ORDER BY idx', blobId, range.offset, range.offset + range.length),
  )

export const openBlob = (db: Database, storage: Storage, blob: BlobRow, range?: ByteRange): ReadableStream<Uint8Array> => {
  const wanted = range ?? { offset: 0, length: blob.size ?? 0 }
  let parts: BlobPart[] | null = null
  let index = 0
  let current: ReadableStreamDefaultReader<Uint8Array> | null = null
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      parts ??= await partsInRange(db, blob.id, wanted)
      for (;;) {
        if (current) {
          const { done, value } = await current.read()
          if (!done) {
            controller.enqueue(value)
            return
          }
          current = null
        }
        const part = parts[index++]
        if (!part) {
          controller.close()
          return
        }
        const start = Math.max(wanted.offset, part.offset)
        const end = Math.min(wanted.offset + wanted.length, part.offset + part.size)
        if (end <= start) continue
        const object = await storage.get(part.key, { offset: start - part.offset, length: end - start })
        if (!object) {
          controller.error(new Error(`missing blob part ${part.key}`))
          return
        }
        current = object.body.getReader()
      }
    },
    async cancel(reason) {
      await current?.cancel(reason)
    },
  })
}

const AZURE_VERSION = '2025-01-05'

const azureHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'x-ms-request-id': crypto.randomUUID(),
  'x-ms-version': AZURE_VERSION,
  ...extra,
})

const xmlEscape = (text: string): string => text.replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`)

export const azureError = (status: number, code: string, message: string): Response =>
  new Response(`<?xml version="1.0" encoding="utf-8"?><Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(message)}</Message></Error>`, {
    status,
    headers: azureHeaders({ 'Content-Type': 'application/xml', 'x-ms-error-code': code }),
  })

const xmlUnescape = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)))
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[entity]!
  })

export const parseBlockList = (xml: string): string[] | null => {
  if (!/<BlockList\b/.test(xml)) return null
  return [...xml.matchAll(/<(Latest|Committed|Uncommitted)>([^<]*)<\/\1>/g)].map((match) => xmlUnescape(match[2]!.trim()))
}

const contentLength = (request: Request): number | null => {
  const header = request.headers.get('Content-Length')
  if (header === null) return null
  const value = Number(header)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

const committed = (blob: BlobRow): Response =>
  new Response(null, {
    status: 201,
    headers: azureHeaders({ ETag: `"${blob.id}"`, 'Last-Modified': new Date(blob.committed_at ?? blob.created_at).toUTCString(), 'x-ms-request-server-encrypted': 'true' }),
  })

const writeBlob = async (request: Request, db: Database, storage: Storage, blob: BlobRow, now: number): Promise<Response> => {
  const url = new URL(request.url)
  const comp = url.searchParams.get('comp')
  if (request.method !== 'PUT') return azureError(405, 'UnsupportedHttpVerb', 'only PUT is allowed with an upload URL')
  if (comp === 'block') {
    const blockId = url.searchParams.get('blockid') ?? ''
    await stageBlock(db, storage, blob, blockId, request.body, contentLength(request), now)
    return new Response(null, { status: 201, headers: azureHeaders({ 'x-ms-request-server-encrypted': 'true' }) })
  }
  if (comp === 'blocklist') {
    const order = parseBlockList(new TextDecoder().decode(await readAll(request.body ?? new ReadableStream(), MAX_UNSIZED_BLOCK_BYTES)))
    if (!order) return azureError(400, 'InvalidXmlDocument', 'expected a BlockList')
    return committed(await commitBlockList(db, blob, order, now))
  }
  if (comp !== null) return azureError(400, 'InvalidQueryParameterValue', `comp=${comp} is not supported`)
  if ((request.headers.get('x-ms-blob-type') ?? 'BlockBlob') !== 'BlockBlob') return azureError(400, 'InvalidHeaderValue', 'only block blobs are supported')
  await stageBlock(db, storage, blob, 'single', request.body, contentLength(request), now)
  return committed(await commitBlockList(db, blob, ['single'], now))
}

const readBlob = async (request: Request, db: Database, storage: Storage, blob: BlobRow, filename: string | null): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return azureError(405, 'UnsupportedHttpVerb', 'only GET and HEAD are allowed with a download URL')
  if (blob.committed_at === null || blob.size === null) return azureError(404, 'BlobNotFound', 'the blob is not committed')
  const range = parseRange(request.headers.get('Range') ?? request.headers.get('x-ms-range'), blob.size)
  const headers: Record<string, string> = azureHeaders({
    'Content-Type': blob.content_type ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: `"${blob.id}"`,
    'Last-Modified': new Date(blob.committed_at).toUTCString(),
    'x-ms-blob-type': 'BlockBlob',
    'Cache-Control': 'private, no-store',
    ...(filename ? { 'Content-Disposition': contentDisposition(filename) } : {}),
  })
  if (range.kind === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${blob.size}` } })
  const partial = range.kind === 'partial' ? range.range : undefined
  const length = partial ? partial.length : blob.size
  return new Response(request.method === 'HEAD' ? null : (openBlob(db, storage, blob, partial) as ReadableStream<Uint8Array<ArrayBuffer>>), {
    status: partial ? 206 : 200,
    headers: {
      ...headers,
      'Content-Length': String(length),
      ...(partial ? { 'Content-Range': `bytes ${partial.offset}-${partial.offset + partial.length - 1}/${blob.size}` } : {}),
    },
  })
}

export const handleBlobRequest = async (request: Request, db: Database, storage: Storage, now: number): Promise<Response | null> => {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(BLOB_PATH)) return null
  const [token] = url.pathname.slice(BLOB_PATH.length).split('/')
  const grant = token ? await verifyBlobGrant(db, token, now) : null
  const blob = grant ? await getBlob(db, grant.blob_id) : null
  if (!grant || !blob) return azureError(403, 'AuthenticationFailed', 'the URL is invalid or has expired')
  try {
    return grant.access === 'write' ? await writeBlob(request, db, storage, blob, now) : await readBlob(request, db, storage, blob, grant.filename)
  } catch (error) {
    if (error instanceof BlobError) return azureError(error.status, error.code, error.message)
    throw error
  }
}
