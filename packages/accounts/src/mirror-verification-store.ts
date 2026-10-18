import { type Database, sql } from './database.ts'
import type { VerifiedAttestation } from './mirror-attestation.ts'

export type StoredMirrorAttestation = {
  readonly repository: string
  readonly issuer: string
  readonly namespace: string
  readonly checksum: string
  readonly refs: number
  readonly syncedAt: string
  readonly alarms: number
  readonly pending: number
  readonly deepCheck?: { readonly at: string; readonly ok: boolean }
  readonly url?: string
  readonly token: string
  readonly receivedAt: string
}

export type ChecksumRecord = {
  readonly checksum: string
  readonly refs: number
  readonly firstSeen: string
}

export type StoredSpotCheck = {
  readonly issuer: string
  readonly at: string
  readonly ok: boolean
  readonly samples: number
  readonly skipped: number
  readonly problems: readonly string[]
}

type AttestationRow = {
  repository: string
  issuer: string
  namespace: string
  checksum: string
  refs: number
  synced_at: number
  alarms: number
  pending: number
  deep_check_at: number | null
  deep_check_ok: number | null
  url: string | null
  token: string
  received_at: number
}

const iso = (ms: number) => new Date(ms).toISOString()

const toAttestation = (row: AttestationRow): StoredMirrorAttestation => ({
  repository: row.repository,
  issuer: row.issuer,
  namespace: row.namespace,
  checksum: row.checksum,
  refs: row.refs,
  syncedAt: iso(row.synced_at),
  alarms: row.alarms,
  pending: row.pending,
  ...(row.deep_check_at !== null ? { deepCheck: { at: iso(row.deep_check_at), ok: row.deep_check_ok === 1 } } : {}),
  ...(row.url !== null ? { url: row.url } : {}),
  token: row.token,
  receivedAt: iso(row.received_at),
})

export const createMirrorVerificationStore = (db: Database, options: { readonly now?: () => number } = {}) => {
  const now = options.now ?? Date.now
  return {
    recordAttestation: async (attestation: VerifiedAttestation, token: string): Promise<void> => {
      await db.run(
        sql(
          `INSERT INTO mirror_attestations (repository, issuer, namespace, checksum, refs, synced_at, alarms, pending, deep_check_at, deep_check_ok, url, token, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repository, issuer) DO UPDATE SET namespace = excluded.namespace, checksum = excluded.checksum, refs = excluded.refs,
             synced_at = excluded.synced_at, alarms = excluded.alarms, pending = excluded.pending, deep_check_at = excluded.deep_check_at,
             deep_check_ok = excluded.deep_check_ok, url = excluded.url, token = excluded.token, received_at = excluded.received_at`,
          attestation.repository.toLowerCase(),
          attestation.issuer,
          attestation.namespace,
          attestation.checksum,
          attestation.refs,
          Date.parse(attestation.syncedAt),
          attestation.alarms,
          attestation.pending,
          attestation.deepCheck ? Date.parse(attestation.deepCheck.at) : null,
          attestation.deepCheck ? (attestation.deepCheck.ok ? 1 : 0) : null,
          attestation.url ?? null,
          token,
          now(),
        ),
      )
    },

    attestations: async (repository: string): Promise<StoredMirrorAttestation[]> =>
      (await db.all<AttestationRow>(sql('SELECT * FROM mirror_attestations WHERE repository = ? ORDER BY issuer', repository.toLowerCase()))).map(toAttestation),

    attestation: async (repository: string, issuer: string): Promise<StoredMirrorAttestation | null> => {
      const rows = await db.all<AttestationRow>(sql('SELECT * FROM mirror_attestations WHERE repository = ? AND issuer = ?', repository.toLowerCase(), issuer))
      return rows[0] ? toAttestation(rows[0]) : null
    },

    recordChecksum: async (repository: string, namespace: string, checksum: string, refs: number): Promise<void> => {
      await db.run(
        sql(
          'INSERT INTO ref_checksums (repository, namespace, checksum, refs, first_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT (repository, namespace, checksum) DO NOTHING',
          repository.toLowerCase(),
          namespace,
          checksum,
          refs,
          now(),
        ),
      )
    },

    checksumHistory: async (repository: string, namespace: string): Promise<ChecksumRecord[]> =>
      (
        await db.all<{ checksum: string; refs: number; first_seen: number }>(
          sql('SELECT checksum, refs, first_seen FROM ref_checksums WHERE repository = ? AND namespace = ? ORDER BY first_seen, checksum', repository.toLowerCase(), namespace),
        )
      ).map((row) => ({ checksum: row.checksum, refs: row.refs, firstSeen: iso(row.first_seen) })),

    recordSpotCheck: async (repository: string, check: StoredSpotCheck): Promise<void> => {
      await db.run(
        sql(
          `INSERT INTO mirror_spot_checks (repository, issuer, checked_at, ok, samples, skipped, problems) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repository, issuer) DO UPDATE SET checked_at = excluded.checked_at, ok = excluded.ok, samples = excluded.samples,
             skipped = excluded.skipped, problems = excluded.problems`,
          repository.toLowerCase(),
          check.issuer,
          Date.parse(check.at),
          check.ok ? 1 : 0,
          check.samples,
          check.skipped,
          JSON.stringify(check.problems),
        ),
      )
    },

    spotChecks: async (repository: string): Promise<StoredSpotCheck[]> =>
      (
        await db.all<{ issuer: string; checked_at: number; ok: number; samples: number; skipped: number; problems: string }>(
          sql('SELECT issuer, checked_at, ok, samples, skipped, problems FROM mirror_spot_checks WHERE repository = ? ORDER BY issuer', repository.toLowerCase()),
        )
      ).map((row) => ({ issuer: row.issuer, at: iso(row.checked_at), ok: row.ok === 1, samples: row.samples, skipped: row.skipped, problems: JSON.parse(row.problems) as string[] })),
  }
}

export type MirrorVerificationStore = ReturnType<typeof createMirrorVerificationStore>
