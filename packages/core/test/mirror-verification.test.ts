import { describe, expect, it } from 'vitest'
import { refsChecksum } from '../src/mirror.ts'
import { evaluateMirror, namespacedChecksum, planSpotCheck, type StoredAttestation } from '../src/mirror-verification.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { handleGitRequest } from '../src/http.ts'
import { createRepository, packKey } from '../src/repository.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const now = new Date('2026-10-18T12:00:00Z')

const attestation = (checksum: string, receivedAt = '2026-10-18T11:00:00Z', extra: Partial<StoredAttestation> = {}): StoredAttestation => ({
  issuer: 'https://beta.example',
  checksum,
  refs: 1,
  namespace: '',
  syncedAt: receivedAt,
  receivedAt,
  alarms: 0,
  pending: 0,
  ...extra,
})

describe('ref checksums', () => {
  it('compares heads and tags only, through the mirror namespace', () => {
    const upstream = namespacedChecksum({ head: 'refs/heads/main', refs: { 'refs/heads/main': A, 'refs/archive/1/heads/x': B, 'refs/tags/v1': B } })
    const mirror = namespacedChecksum(
      { head: 'refs/heads/main', refs: { 'refs/upstream/origin/heads/main': A, 'refs/upstream/origin/tags/v1': B, 'refs/heads/own': B } },
      'upstream/origin/',
    )
    expect(mirror).toEqual(upstream)
    expect(upstream).toEqual({ checksum: refsChecksum([['refs/heads/main', A], ['refs/tags/v1', B]]), refs: 2 })
    expect(namespacedChecksum({ head: 'refs/heads/main', refs: {} }).checksum).toBe('0'.repeat(40))
  })
})

describe('mirror evaluation', () => {
  const current = { checksum: 'c3'.repeat(20), refs: 2 }
  const history = [
    { checksum: 'c1'.repeat(20), firstSeen: '2026-10-17T00:00:00Z' },
    { checksum: 'c2'.repeat(20), firstSeen: '2026-10-18T06:00:00Z' },
    { checksum: current.checksum, firstSeen: '2026-10-18T11:30:00Z' },
  ]

  it('distinguishes current, behind, diverged, unknown, stale and unattested', () => {
    expect(evaluateMirror({ current, history, attestation: null, now })).toEqual({ state: 'unattested', lagSeconds: null, alarms: [] })
    expect(evaluateMirror({ current, history, attestation: attestation(current.checksum), now })).toEqual({ state: 'current', lagSeconds: 0, alarms: [] })
    expect(evaluateMirror({ current, history, attestation: attestation('c2'.repeat(20)), now })).toEqual({ state: 'behind', lagSeconds: 1800, alarms: [] })
    expect(evaluateMirror({ current, history, attestation: attestation('c1'.repeat(20)), now })).toEqual({ state: 'behind', lagSeconds: 6 * 3600, alarms: [] })
    expect(evaluateMirror({ current, history, attestation: attestation('ff'.repeat(20)), now })).toEqual({ state: 'diverged', lagSeconds: null, alarms: ['diverged'] })
    expect(evaluateMirror({ current, history: [], attestation: attestation('ff'.repeat(20)), now }).state).toBe('unknown')
    expect(evaluateMirror({ current, history, attestation: attestation(current.checksum, '2026-10-10T00:00:00Z'), now })).toEqual({ state: 'stale', lagSeconds: 0, alarms: ['stale'] })
  })

  it('raises alarms for lag, mirror alarms, failed deep checks, pending units and spot checks', () => {
    const late = [{ checksum: 'c1'.repeat(20), firstSeen: '2026-10-15T00:00:00Z' }, { checksum: current.checksum, firstSeen: '2026-10-16T00:00:00Z' }]
    expect(evaluateMirror({ current, history: late, attestation: attestation('c1'.repeat(20)), now }).alarms).toEqual(['lagging'])
    const troubled = attestation(current.checksum, '2026-10-18T11:00:00Z', { alarms: 2, pending: 1, deepCheck: { at: '2026-10-01T00:00:00Z', ok: false } })
    const spotCheck = { at: '2026-10-18T11:00:00Z', ok: false, samples: 4, skipped: 0, problems: ['x'] }
    expect(evaluateMirror({ current, history, attestation: troubled, spotCheck, now }).alarms).toEqual(['mirror-alarms', 'deep-check-failed', 'pending-units', 'spot-check-failed'])
  })
})

describe('spot check plans', () => {
  it('samples ranges inside packs and LFS objects', () => {
    let seed = 1
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const plan = planSpotCheck({ packs: [{ name: 'pack-1.pack', size: 10_000 }], lfs: [{ oid: 'f'.repeat(64), size: 100 }, { oid: 'e'.repeat(64), size: 0 }] }, 50, random)
    expect(plan).toHaveLength(50)
    for (const sample of plan) {
      const size = sample.kind === 'pack' ? 10_000 : 100
      expect(sample.offset + sample.length).toBeLessThanOrEqual(size)
      expect(sample.length).toBe(Math.min(4096, size))
    }
    expect(new Set(plan.map((sample) => sample.kind))).toEqual(new Set(['pack', 'lfs']))
    expect(planSpotCheck({ packs: [], lfs: [] }, 5)).toEqual([])
  })
})

describe('dumb HTTP ranges', () => {
  it('serves byte ranges of pack files', async () => {
    const storage = new MemoryStorage()
    const repo = { owner: 'acme', name: 'site' }
    await createRepository(storage, repo)
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251)
    await storage.put(packKey(repo, `pack-${A}.pack`), bytes, bytes.length)
    const request = (range?: string) =>
      handleGitRequest(new Request(`https://forge.example/acme/site.git/objects/pack/pack-${A}.pack`, range ? { headers: { Range: range } } : {}), { storage, authorize: async () => null })
    const partial = (await request('bytes=10-19'))!
    expect(partial.status).toBe(206)
    expect(partial.headers.get('Content-Range')).toBe('bytes 10-19/1000')
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.slice(10, 20))
    expect((await request('bytes=5000-'))!.status).toBe(416)
    expect((await request())!.status).toBe(200)
  })
})
