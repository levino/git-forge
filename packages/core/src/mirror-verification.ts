import type { ObjectId } from './hash.ts'
import { refsChecksum, selectUpstreamRefs } from './mirror.ts'
import { advertisedRefs, type RefsState } from './repository.ts'

export type RefChecksum = {
  readonly checksum: string
  readonly refs: number
}

export const namespacedChecksum = (state: RefsState, namespace = ''): RefChecksum => {
  const listed = Object.entries(advertisedRefs(state).refs).map(([name, id]) => ({ name, id: id as ObjectId }))
  const { refs } = selectUpstreamRefs(listed, namespace)
  return { checksum: refsChecksum(refs), refs: refs.size }
}

export type AttestationClaims = {
  readonly checksum: string
  readonly refs: number
  readonly namespace: string
  readonly syncedAt: string
  readonly alarms: number
  readonly pending: number
  readonly deepCheck?: { readonly at: string; readonly ok: boolean }
  readonly url?: string
}

export type StoredAttestation = AttestationClaims & {
  readonly issuer: string
  readonly receivedAt: string
}

export type ChecksumHistoryEntry = {
  readonly checksum: string
  readonly firstSeen: string
}

export type SpotCheckResult = {
  readonly at: string
  readonly ok: boolean
  readonly samples: number
  readonly skipped: number
  readonly problems: readonly string[]
}

export type MirrorState = 'current' | 'behind' | 'diverged' | 'unknown' | 'stale' | 'unattested'

export type MirrorAlarmKind = 'stale' | 'diverged' | 'lagging' | 'mirror-alarms' | 'deep-check-failed' | 'pending-units' | 'spot-check-failed'

export type MirrorEvaluation = {
  readonly state: MirrorState
  readonly lagSeconds: number | null
  readonly alarms: readonly MirrorAlarmKind[]
}

export type EvaluationPolicy = {
  readonly staleAfterSeconds: number
  readonly lagAlarmSeconds: number
}

export const DEFAULT_EVALUATION_POLICY: EvaluationPolicy = {
  staleAfterSeconds: 3 * 24 * 60 * 60,
  lagAlarmSeconds: 26 * 60 * 60,
}

const seconds = (from: string, to: Date): number => Math.max(0, Math.round((to.getTime() - Date.parse(from)) / 1000))

export const evaluateMirror = (
  input: {
    readonly current: RefChecksum
    readonly history: readonly ChecksumHistoryEntry[]
    readonly attestation: StoredAttestation | null
    readonly spotCheck?: SpotCheckResult | null
    readonly now: Date
  },
  policy: EvaluationPolicy = DEFAULT_EVALUATION_POLICY,
): MirrorEvaluation => {
  const { attestation, now } = input
  if (!attestation) return { state: 'unattested', lagSeconds: null, alarms: [] }
  const alarms: MirrorAlarmKind[] = []
  if (attestation.alarms > 0) alarms.push('mirror-alarms')
  if (attestation.deepCheck && !attestation.deepCheck.ok) alarms.push('deep-check-failed')
  if (attestation.pending > 0) alarms.push('pending-units')
  if (input.spotCheck && !input.spotCheck.ok) alarms.push('spot-check-failed')
  const age = seconds(attestation.receivedAt, now)
  let state: MirrorState
  let lagSeconds: number | null
  if (attestation.checksum === input.current.checksum) {
    state = 'current'
    lagSeconds = 0
  } else {
    const ordered = [...input.history].sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen))
    const index = ordered.findIndex((entry) => entry.checksum === attestation.checksum)
    if (index === -1) {
      state = ordered.length === 0 ? 'unknown' : 'diverged'
      lagSeconds = null
      if (state === 'diverged') alarms.push('diverged')
    } else {
      state = 'behind'
      const next = ordered.slice(index + 1).find((entry) => entry.checksum !== attestation.checksum)
      lagSeconds = next ? seconds(next.firstSeen, now) : null
      if (lagSeconds !== null && lagSeconds > policy.lagAlarmSeconds) alarms.push('lagging')
    }
  }
  if (age > policy.staleAfterSeconds) {
    alarms.unshift('stale')
    if (state === 'current' || state === 'behind') state = 'stale'
  }
  return { state, lagSeconds, alarms }
}

export type SpotSample =
  | { readonly kind: 'pack'; readonly name: string; readonly offset: number; readonly length: number }
  | { readonly kind: 'lfs'; readonly oid: string; readonly offset: number; readonly length: number }

export type SpotCandidates = {
  readonly packs: readonly { readonly name: string; readonly size: number }[]
  readonly lfs: readonly { readonly oid: string; readonly size: number }[]
}

export const DEFAULT_SAMPLE_BYTES = 4096

export const planSpotCheck = (candidates: SpotCandidates, samples: number, random: () => number = Math.random, length = DEFAULT_SAMPLE_BYTES): SpotSample[] => {
  const pool: ({ readonly kind: 'pack'; readonly name: string; readonly size: number } | { readonly kind: 'lfs'; readonly oid: string; readonly size: number })[] = [
    ...candidates.packs.filter((pack) => pack.size > 0).map((pack) => ({ kind: 'pack' as const, ...pack })),
    ...candidates.lfs.filter((object) => object.size > 0).map((object) => ({ kind: 'lfs' as const, ...object })),
  ]
  const plan: SpotSample[] = []
  if (pool.length === 0) return plan
  for (let i = 0; i < samples; i++) {
    const pick = pool[Math.floor(random() * pool.length) % pool.length]!
    const take = Math.min(length, pick.size)
    const offset = Math.floor(random() * (pick.size - take + 1))
    plan.push(pick.kind === 'pack' ? { kind: 'pack', name: pick.name, offset, length: take } : { kind: 'lfs', oid: pick.oid, offset, length: take })
  }
  return plan
}
