import { describe, expect, it } from 'vitest'
import { concat, readAll, streamOf, utf8 } from '../src/bytes.ts'
import { sha256Hex } from '../src/hash.ts'
import { LfsIntegrityError, lfsObjectKey, parseLfsPointer, verifyingStream } from '../src/lfs.ts'
import { lfsEndpointFor, mirrorLfsObjects } from '../src/lfs-mirror.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import {
  configureMirror,
  isMirrorDue,
  type MirrorConfig,
  type MirrorStatus,
  planRefUpdates,
  refsChecksum,
  selectUpstreamRefs,
  setMirrorMode,
  listMirrors,
  MirrorExistsError,
} from '../src/mirror.ts'
import { DELIM, FLUSH, pkt, sideband, SIDEBAND_DATA, SIDEBAND_ERROR, SIDEBAND_PROGRESS } from '../src/pktline.ts'
import { validRefName } from '../src/receive-pack.ts'
import { parseInfoRefs } from '../src/remote.ts'
import { createRepository } from '../src/repository.ts'
import { parseFetchResponse, parseV2Advertisement } from '../src/smart-client.ts'
import { lfsPointer, randomBytes } from './mirror-helpers.ts'

const id = (n: number) => n.toString(16).padStart(40, '0')

const chunked = (bytes: Uint8Array, size: number): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size))
      controller.close()
    },
  })

describe('refs checksum', () => {
  it('is order independent, zero for no refs and cancels duplicates', () => {
    const a: [string, string] = ['refs/heads/main', id(1)]
    const b: [string, string] = ['refs/tags/v1', id(2)]
    expect(refsChecksum([])).toBe('0'.repeat(40))
    expect(refsChecksum([a, b])).toBe(refsChecksum([b, a]))
    expect(refsChecksum([a, b, b])).toBe(refsChecksum([a]))
    expect(refsChecksum([a])).not.toBe(refsChecksum([['refs/heads/main', id(3)]]))
  })
})

describe('upstream ref selection', () => {
  it('maps heads and tags of the namespace and ignores everything else', () => {
    const selected = selectUpstreamRefs(
      [
        { name: 'refs/heads/main', id: id(1) },
        { name: 'refs/tags/v1', id: id(2), peeled: id(3) },
        { name: 'refs/pull/1/head', id: id(4) },
        { name: 'refs/heads/bad..name', id: id(5) },
        { name: 'refs/upstream/origin/heads/x', id: id(6) },
      ],
      '',
      'refs/heads/main',
    )
    expect([...selected.refs]).toEqual([
      ['refs/heads/main', id(1)],
      ['refs/tags/v1', id(2)],
    ])
    expect(selected.ignored).toEqual(['refs/heads/bad..name'])
    expect(selected.head).toBe('refs/heads/main')
  })

  it('reads a chained mirror from its refs/upstream namespace', () => {
    const selected = selectUpstreamRefs(
      [
        { name: 'refs/heads/own', id: id(1) },
        { name: 'refs/upstream/origin/heads/main', id: id(2) },
        { name: 'refs/upstream/origin/tags/v1', id: id(3) },
        { name: 'refs/upstream/other/heads/main', id: id(4) },
      ],
      'upstream/origin/',
    )
    expect([...selected.refs]).toEqual([
      ['refs/heads/main', id(2)],
      ['refs/tags/v1', id(3)],
    ])
  })
})

describe('ref update planning', () => {
  const at = new Date('2026-10-18T12:00:00.000Z')
  const ancestry = (pairs: [string, string][]) => async (oldId: string, newId: string) => pairs.some(([a, b]) => a === oldId && b === newId)

  it('creates, fast-forwards, archives rewrites and deletions and leaves other refs alone', async () => {
    const current = {
      'refs/heads/own': id(9),
      'refs/upstream/origin/heads/main': id(1),
      'refs/upstream/origin/heads/rewritten': id(2),
      'refs/upstream/origin/heads/gone': id(3),
      'refs/upstream/origin/tags/v1': id(4),
      'refs/upstream/other/heads/main': id(8),
    }
    const upstream = new Map([
      ['refs/heads/main', id(11)],
      ['refs/heads/rewritten', id(12)],
      ['refs/heads/new', id(13)],
      ['refs/tags/v1', id(14)],
    ])
    const plan = await planRefUpdates(current, 'origin', upstream, at, ancestry([[id(1), id(11)]]))
    expect(plan.updates).toEqual([
      { ref: 'refs/upstream/origin/heads/main', oldId: id(1), newId: id(11), kind: 'fast-forward' },
      { ref: 'refs/upstream/origin/heads/new', oldId: null, newId: id(13), kind: 'created' },
      { ref: 'refs/upstream/origin/heads/rewritten', oldId: id(2), newId: id(12), kind: 'forced' },
      { ref: 'refs/upstream/origin/tags/v1', oldId: id(4), newId: id(14), kind: 'forced' },
      { ref: 'refs/upstream/origin/heads/gone', oldId: id(3), newId: null, kind: 'deleted' },
    ])
    const stamp = '2026-10-18T12-00-00-000Z'
    expect(plan.refs).toEqual({
      'refs/heads/own': id(9),
      'refs/upstream/other/heads/main': id(8),
      'refs/upstream/origin/heads/main': id(11),
      'refs/upstream/origin/heads/new': id(13),
      'refs/upstream/origin/heads/rewritten': id(12),
      'refs/upstream/origin/tags/v1': id(14),
      [`refs/archive/${stamp}/upstream/origin/heads/rewritten`]: id(2),
      [`refs/archive/${stamp}/upstream/origin/tags/v1`]: id(4),
      [`refs/archive/${stamp}/upstream/origin/heads/gone`]: id(3),
    })
    expect(plan.alarms.map((alarm) => [alarm.kind, alarm.ref, alarm.archivedAs])).toEqual([
      ['history-rewritten', 'refs/heads/rewritten', `refs/archive/${stamp}/upstream/origin/heads/rewritten`],
      ['history-rewritten', 'refs/tags/v1', `refs/archive/${stamp}/upstream/origin/tags/v1`],
      ['ref-deleted', 'refs/heads/gone', `refs/archive/${stamp}/upstream/origin/heads/gone`],
    ])
  })

  it('is a no-op when everything is in sync', async () => {
    const plan = await planRefUpdates({ 'refs/upstream/origin/heads/main': id(1) }, 'origin', new Map([['refs/heads/main', id(1)]]), at, ancestry([]))
    expect(plan.updates).toEqual([])
    expect(plan.alarms).toEqual([])
  })
})

describe('push validation', () => {
  it('rejects refs under refs/upstream and refs/archive', () => {
    expect(validRefName('refs/heads/main')).toBe(true)
    expect(validRefName('refs/upstream/origin/heads/main')).toBe(false)
    expect(validRefName('refs/archive/x/heads/main')).toBe(false)
  })
})

describe('protocol v2 client parsing', () => {
  it('recognises v2 advertisements and rejects v0', async () => {
    const v2 = concat([pkt('# service=git-upload-pack\n'), FLUSH, pkt('version 2\n'), pkt('agent=x\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow\n'), FLUSH])
    const capabilities = await parseV2Advertisement(chunked(v2, 3))
    expect(capabilities && [...capabilities]).toEqual([
      ['agent', 'x'],
      ['ls-refs', 'unborn'],
      ['fetch', 'shallow'],
    ])
    const v0 = concat([pkt('# service=git-upload-pack\n'), FLUSH, pkt(`${id(1)} HEAD\0multi_ack\n`), FLUSH])
    expect(await parseV2Advertisement(streamOf(v0))).toBeNull()
  })

  it('demultiplexes the sideband and collects acknowledgments', async () => {
    const pack = randomBytes(150_000, 5)
    const response = concat([
      pkt('acknowledgments\n'),
      pkt(`ACK ${id(1)}\n`),
      pkt('ready\n'),
      DELIM,
      pkt('packfile\n'),
      ...sideband(SIDEBAND_PROGRESS, utf8('Counting objects\n')),
      ...sideband(SIDEBAND_DATA, pack),
      FLUSH,
    ])
    const parsed = await parseFetchResponse(chunked(response, 4093))
    expect(parsed.acks).toEqual([id(1)])
    expect(parsed.ready).toBe(true)
    expect(parsed.progress).toBe('Counting objects\n')
    expect(parsed.pack).toEqual(pack)
  })

  it('returns no pack for a pure negotiation round', async () => {
    const parsed = await parseFetchResponse(streamOf(concat([pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH])))
    expect(parsed).toMatchObject({ acks: [], ready: false, pack: null })
  })

  it('surfaces remote errors and truncation', async () => {
    await expect(parseFetchResponse(streamOf(concat([pkt('packfile\n'), ...sideband(SIDEBAND_ERROR, utf8('upload-pack: not our ref\n')), FLUSH])))).rejects.toThrow(
      /not our ref/,
    )
    await expect(parseFetchResponse(streamOf(concat([pkt('ERR access denied\n')]))).catch((error: Error) => error.message)).resolves.toMatch(/access denied/)
    await expect(parseFetchResponse(streamOf(concat([pkt('packfile\n'), ...sideband(SIDEBAND_DATA, utf8('PACK'))])))).rejects.toThrow(/truncated/)
    await expect(parseFetchResponse(streamOf(concat([pkt('packfile\n'), ...sideband(SIDEBAND_DATA, randomBytes(100, 1)), FLUSH])), 50)).rejects.toThrow(/exceeds/)
  })

  it('parses dumb info/refs with peeled tags', () => {
    expect(parseInfoRefs(`${id(1)}\trefs/heads/main\n${id(2)}\trefs/tags/v1\n${id(3)}\trefs/tags/v1^{}\n`)).toEqual([
      { name: 'refs/heads/main', id: id(1) },
      { name: 'refs/tags/v1', id: id(2), peeled: id(3) },
    ])
  })
})

describe('LFS pointers', () => {
  it('parses valid pointers and rejects anything else', () => {
    const { text, oid, size } = lfsPointer(utf8('hello'))
    expect(parseLfsPointer(utf8(text))).toEqual({ oid, size })
    expect(parseLfsPointer(utf8(text.replace('git-lfs.github.com', 'example.org')))).toBeNull()
    expect(parseLfsPointer(utf8(text.replace(oid, '../../etc/passwd')))).toBeNull()
    expect(parseLfsPointer(utf8(text.replace(`size ${size}`, 'size -1')))).toBeNull()
    expect(parseLfsPointer(utf8(`${text}${'x'.repeat(1024)}`))).toBeNull()
    expect(parseLfsPointer(utf8('just a file\n'))).toBeNull()
  })

  it('derives the LFS endpoint like git-lfs', () => {
    expect(lfsEndpointFor('https://example.org/o/r.git')).toBe('https://example.org/o/r.git/info/lfs')
    expect(lfsEndpointFor('https://example.org/o/r')).toBe('https://example.org/o/r.git/info/lfs')
    expect(lfsEndpointFor('https://example.org/o/r/')).toBe('https://example.org/o/r.git/info/lfs')
  })

  it('verifies size and sha256 while streaming', async () => {
    const data = randomBytes(10_000, 9)
    const pointer = { oid: sha256Hex(data), size: data.length }
    expect(await readAll(chunked(data, 999).pipeThrough(verifyingStream(pointer)))).toEqual(data)
    await expect(readAll(chunked(data, 999).pipeThrough(verifyingStream({ ...pointer, size: 9_999 })))).rejects.toThrow(LfsIntegrityError)
    await expect(readAll(chunked(data, 999).pipeThrough(verifyingStream({ ...pointer, size: 10_001 })))).rejects.toThrow(/10000 bytes/)
    const tampered = data.slice()
    tampered[5000] = (tampered[5000] as number) ^ 1
    await expect(readAll(chunked(tampered, 999).pipeThrough(verifyingStream(pointer)))).rejects.toThrow(/sha256/)
  })
})

describe('LFS mirroring', () => {
  const repo = { owner: 'o', name: 'r' }
  const good = randomBytes(5000, 1)
  const bad = randomBytes(6000, 2)
  const absent = randomBytes(10, 3)
  const objects = [good, bad, absent].map((data) => ({ oid: sha256Hex(data), size: data.length }))

  const fakeFetch = (status = 200) => async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/objects/batch')) {
      if (status !== 200) return new Response('no', { status })
      const body = (await request.json()) as { operation: string; transfers: string[]; objects: { oid: string; size: number }[] }
      expect(body.operation).toBe('download')
      expect(body.transfers).toEqual(['basic'])
      expect(request.headers.get('Accept')).toBe('application/vnd.git-lfs+json')
      return Response.json({
        objects: body.objects.map((object) =>
          object.oid === objects[2]?.oid
            ? { ...object, error: { code: 404, message: 'Object does not exist' } }
            : { ...object, actions: { download: { href: `https://cdn.example.org/${object.oid}`, header: { 'X-Token': 't' } } } },
        ),
      })
    }
    expect(request.headers.get('X-Token')).toBe('t')
    expect(request.headers.get('Authorization')).toBeNull()
    const oid = url.pathname.slice(1)
    if (oid === objects[0]?.oid) return new Response(good as Uint8Array<ArrayBuffer>)
    return new Response(good.subarray(0, bad.length) as Uint8Array<ArrayBuffer>)
  }

  it('stores verified objects content-addressed and reports the rest as missing', async () => {
    const storage = new MemoryStorage()
    const result = await mirrorLfsObjects({
      storage,
      repo,
      remote: { url: 'https://forge.example.org/o/r.git', fetch: fakeFetch(), getAuthorization: async () => 'Bearer secret' },
      objects: [...objects, objects[0] as (typeof objects)[number]],
    })
    expect(result.downloaded).toEqual([objects[0]])
    expect(result.missing.map((missing) => missing.oid).sort()).toEqual([objects[1]?.oid, objects[2]?.oid].sort())
    expect(result.missing.find((missing) => missing.oid === objects[2]?.oid)?.reason).toMatch(/does not exist/)
    const key = lfsObjectKey(repo, objects[0]?.oid as string)
    const oid = objects[0]?.oid as string
    expect(key).toBe(`repos/o/r/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`)
    expect(await readAll((await storage.get(key))?.body as ReadableStream<Uint8Array>)).toEqual(good)
    expect(await storage.head(lfsObjectKey(repo, objects[1]?.oid as string))).toBeNull()

    const again = await mirrorLfsObjects({ storage, repo, remote: { url: 'https://forge.example.org/o/r.git', fetch: fakeFetch() }, objects: [objects[0] as (typeof objects)[number]] })
    expect(again).toMatchObject({ present: 1, downloaded: [] })
  })

  it('treats a missing batch endpoint as pending objects and other errors as failures', async () => {
    const storage = new MemoryStorage()
    const remote = (status: number) => ({ url: 'https://forge.example.org/o/r.git', fetch: fakeFetch(status) })
    const missing = await mirrorLfsObjects({ storage, repo, remote: remote(404), objects })
    expect(missing.missing).toHaveLength(3)
    await expect(mirrorLfsObjects({ storage, repo, remote: remote(401), objects })).rejects.toThrow(/401/)
  })
})

describe('mirror configuration', () => {
  const repo = { owner: 'o', name: 'r' }
  const config: MirrorConfig = { version: 1, remote: 'origin', url: 'https://x', mode: 'auto', namespace: '', lfs: true, createdAt: '' }
  const status = (startedAt: string, finishedAt?: string): MirrorStatus => ({
    version: 1,
    remote: 'origin',
    lastRun: { startedAt, ...(finishedAt ? { finishedAt } : {}) },
    lfsPending: [],
    alarms: [],
  })

  it('validates and stores settings per remote', async () => {
    const storage = new MemoryStorage()
    await expect(configureMirror(storage, repo, { url: 'https://example.org/a.git' })).rejects.toThrow(/not found/)
    await createRepository(storage, repo)
    await expect(configureMirror(storage, repo, { url: 'file:///etc' })).rejects.toThrow(/invalid upstream URL/)
    await expect(configureMirror(storage, repo, { url: 'https://example.org/a.git', remote: '../x' })).rejects.toThrow(/invalid remote/)
    await expect(configureMirror(storage, repo, { url: 'https://example.org/a.git', namespace: '../' })).rejects.toThrow(/namespace/)
    await configureMirror(storage, repo, { url: 'https://example.org/a.git' })
    await configureMirror(storage, repo, { url: 'https://example.org/b.git', remote: 'second', mode: 'manual' })
    await expect(configureMirror(storage, repo, { url: 'https://example.org/c.git' })).rejects.toThrow(MirrorExistsError)
    expect((await setMirrorMode(storage, repo, 'manual')).mode).toBe('manual')
    expect((await listMirrors(storage, repo)).map((mirror) => [mirror.remote, mirror.mode])).toEqual([
      ['origin', 'manual'],
      ['second', 'manual'],
    ])
  })

  it('schedules only automatic, attached mirrors', () => {
    const now = new Date('2026-10-18T12:00:00Z')
    expect(isMirrorDue(config, null, now, 3600_000)).toBe(true)
    expect(isMirrorDue(config, status('2026-10-18T11:30:00Z', '2026-10-18T11:31:00Z'), now, 3600_000)).toBe(false)
    expect(isMirrorDue(config, status('2026-10-18T10:30:00Z', '2026-10-18T10:31:00Z'), now, 3600_000)).toBe(true)
    expect(isMirrorDue(config, status('2026-10-18T11:59:00Z'), now, 60_000)).toBe(false)
    expect(isMirrorDue(config, status('2026-10-18T01:00:00Z'), now, 60_000)).toBe(true)
    expect(isMirrorDue({ ...config, mode: 'manual' }, null, now, 1)).toBe(false)
    expect(isMirrorDue({ ...config, detachedAt: now.toISOString() }, null, now, 1)).toBe(false)
  })
})
