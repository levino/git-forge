import { applyMigrations, createMirrorVerificationStore, MIGRATIONS } from '@git-forge/accounts'
import { describe, expect, it } from 'vitest'
import { openSqliteDatabase } from '../src/index.ts'

const MIRROR = 'https://beta.example'
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0)

const claims = {
  repository: 'village/archive',
  checksum: 'c'.repeat(40),
  refs: 3,
  namespace: '',
  syncedAt: '2026-10-18T11:59:00.000Z',
  alarms: 0,
  pending: 1,
  deepCheck: { at: '2026-10-01T00:00:00.000Z', ok: true },
  url: `${MIRROR}/village/archive.git`,
}

describe('mirror verification store', () => {
  it('are stored as the latest per mirror, next to the upstream checksum history', async () => {
    const { db } = openSqliteDatabase(':memory:')
    await applyMigrations(db, MIGRATIONS)
    let clock = NOW
    const store = createMirrorVerificationStore(db, { now: () => clock })
    const verified = { ...claims, repository: 'village/archive', issuer: MIRROR, id: 'j1', keyThumbprint: 'k' }
    await store.recordAttestation(verified, 'token-1')
    await store.recordAttestation({ ...verified, checksum: 'd'.repeat(40) }, 'token-2')
    expect(await store.attestations('Village/Archive')).toEqual([
      expect.objectContaining({ issuer: MIRROR, checksum: 'd'.repeat(40), token: 'token-2', pending: 1, deepCheck: claims.deepCheck, receivedAt: new Date(NOW).toISOString() }),
    ])
    await store.recordChecksum('village/archive', '', 'a'.repeat(40), 1)
    clock += 1000
    await store.recordChecksum('village/archive', '', 'b'.repeat(40), 2)
    await store.recordChecksum('village/archive', '', 'a'.repeat(40), 1)
    expect((await store.checksumHistory('village/archive', '')).map((entry) => entry.checksum)).toEqual(['a'.repeat(40), 'b'.repeat(40)])
    await store.recordSpotCheck('village/archive', { issuer: MIRROR, at: new Date(NOW).toISOString(), ok: false, samples: 2, skipped: 1, problems: ['bytes differ'] })
    expect(await store.spotChecks('village/archive')).toEqual([{ issuer: MIRROR, at: new Date(NOW).toISOString(), ok: false, samples: 2, skipped: 1, problems: ['bytes differ'] }])
  })
})
