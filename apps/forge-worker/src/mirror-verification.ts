import {
  ATTESTATIONS_PATH,
  mintInstanceToken,
  mintMirrorAttestation,
  type MirrorVerificationStore,
  parseUpstreamUrl,
  signMirrorOverview,
  type SigningKey,
  type StoredSpotCheck,
  verifyMirrorAttestation,
} from '@git-forge/accounts'
import {
  evaluateMirror,
  lfsPrefix,
  listMirrors,
  namespacedChecksum,
  ObjectDatabase,
  packKey,
  PermanentJobError,
  planSpotCheck,
  readAll,
  readMirrorConfig,
  readMirrorStatus,
  readRefs,
  type ReadView,
  type RefsState,
  type RepositoryName,
  type SpotSample,
  type Storage,
  sha256Hex,
  upstreamRefPrefix,
  visibleRefs,
} from '@git-forge/core'
import type { MirrorFederation } from './mirror-federation.ts'

export const SPOT_CHECK_SAMPLES = 8

export const SPOT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

const LFS_CANDIDATES = 1000

const nameOf = (repo: RepositoryName): string => `${repo.owner}/${repo.name}`.toLowerCase()

export type InstanceRead = ReadView | 'full' | null

const viewChecksum = async (verification: MirrorVerificationStore, repository: string, state: RefsState, namespace: string, issuer: string, read: InstanceRead) => {
  if (!read || read === 'full') return { key: namespace, current: namespacedChecksum(state, namespace) }
  const key = `view:${issuer}:${namespace}`
  const current = namespacedChecksum(visibleRefs(state, read, true), namespace)
  await verification.recordChecksum(repository, key, current.checksum, current.refs)
  return { key, current }
}

const repositoryOf = (repository: string): RepositoryName => {
  const [owner = '', name = ''] = repository.split('/')
  return { owner, name }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const recordChecksums = async (verification: MirrorVerificationStore, storage: Storage, repo: RepositoryName): Promise<void> => {
  const refs = await readRefs(storage, repo)
  if (!refs) return
  const namespaces = ['', ...(await listMirrors(storage, repo)).map((config) => `upstream/${config.remote}/`)]
  for (const namespace of namespaces) {
    const { checksum, refs: count } = namespacedChecksum(refs.state, namespace)
    await verification.recordChecksum(nameOf(repo), namespace, checksum, count)
  }
}

export const mirrorGitUrl = (issuer: string, repo: RepositoryName): string => `${issuer.replace(/\/+$/, '')}/${repo.owner}/${repo.name}.git`

export const sendAttestation = async (federation: MirrorFederation, repository: string, remote: string): Promise<void> => {
  const repo = repositoryOf(repository)
  const config = await readMirrorConfig(federation.storage, repo, remote)
  if (!config || config.detachedAt || config.auth !== 'instance') return
  const status = await readMirrorStatus(federation.storage, repo, remote)
  const refs = await readRefs(federation.storage, repo)
  if (!status?.lastSuccessAt || !refs) return
  const held = namespacedChecksum(refs.state, upstreamRefPrefix(remote).slice('refs/'.length))
  const upstream = parseUpstreamUrl(config.url, new URL(config.url).origin)
  const token = await mintMirrorAttestation({
    key: federation.instanceKey,
    issuer: federation.issuer,
    audience: upstream.issuer,
    attestation: {
      repository: upstream.repository,
      checksum: held.checksum,
      refs: held.refs,
      namespace: config.namespace,
      syncedAt: status.lastSuccessAt,
      alarms: status.alarms.length,
      pending: status.lfsPending.length + (status.pendingPacks?.length ?? 0),
      ...(status.lastDeepCheck ? { deepCheck: { at: status.lastDeepCheck.at, ok: status.lastDeepCheck.ok } } : {}),
      url: mirrorGitUrl(federation.issuer, repo),
    },
  })
  const response = await (federation.fetch ?? globalThis.fetch)(
    new Request(`${upstream.issuer}${ATTESTATIONS_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/jwt' }, body: token }),
  )
  const detail = (await response.text()).slice(0, 200)
  if (response.ok) return
  const message = `attestation to ${upstream.issuer} failed with HTTP ${response.status}: ${detail}`
  if (response.status >= 400 && response.status < 500 && response.status !== 429) throw new PermanentJobError(message)
  throw new Error(message)
}

export const handleAttestation = async (federation: MirrorFederation, request: Request): Promise<Response> => {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  if (!request.body) return json(400, { error: 'expected a signed attestation' })
  let token: string
  try {
    token = new TextDecoder().decode(await readAll(request.body, 16 * 1024)).trim()
  } catch {
    return json(413, { error: 'request body too large' })
  }
  const verified = await verifyMirrorAttestation(token, { audience: federation.issuer, trust: federation.store.lookupTrustedIssuer, jwks: federation.jwks })
  if (!verified.ok) return json(401, { error: `attestation rejected: ${verified.reason}` })
  const { attestation } = verified
  const repo = repositoryOf(attestation.repository)
  const principal = { kind: 'instance' as const, issuer: attestation.issuer, repositories: [attestation.repository], scopes: ['git:read'], tokenId: attestation.id }
  const refs = await readRefs(federation.storage, repo)
  const read = refs ? await federation.canRead(principal, repo) : null
  if (!refs || !read) return json(404, { error: 'repository not found' })
  const previous = (await federation.verification.spotChecks(attestation.repository)).find((check) => check.issuer === attestation.issuer)
  await federation.verification.recordAttestation(attestation, token)
  await recordChecksums(federation.verification, federation.storage, repo)
  await viewChecksum(federation.verification, attestation.repository, refs.state, attestation.namespace, attestation.issuer, read)
  const now = (federation.now ?? (() => new Date()))()
  if (attestation.url && (!previous || now.getTime() - Date.parse(previous.at) >= SPOT_CHECK_INTERVAL_MS)) {
    await federation.jobs.enqueue({ kind: 'mirror-spot-check', repository: attestation.repository, issuer: attestation.issuer })
  }
  return json(202, { status: 'recorded' })
}

const sampleUrl = (mirrorUrl: string, sample: SpotSample): string => {
  const base = mirrorUrl.replace(/\/+$/, '')
  return sample.kind === 'pack' ? `${base}/objects/pack/${sample.name}` : `${base.replace(/\.git$/, '')}/media/${sample.oid}`
}

export type SpotCheckOptions = {
  readonly storage: Storage
  readonly repo: RepositoryName
  readonly mirrorUrl: string
  readonly fetch: (request: Request) => Promise<Response>
  readonly authorization?: string
  readonly samples?: number
  readonly random?: () => number
  readonly now: Date
}

export const spotCheck = async (options: SpotCheckOptions): Promise<Omit<StoredSpotCheck, 'issuer'>> => {
  const odb = new ObjectDatabase(options.storage, options.repo)
  const packs: { name: string; size: number }[] = []
  for (const name of await odb.packNames()) {
    const info = await options.storage.head(packKey(options.repo, name))
    if (info) packs.push({ name, size: info.size })
  }
  const lfs: { oid: string; size: number }[] = []
  for await (const info of options.storage.list(`${lfsPrefix(options.repo)}objects/`)) {
    const oid = info.key.slice(info.key.lastIndexOf('/') + 1)
    lfs.push({ oid, size: info.size })
    if (lfs.length >= LFS_CANDIDATES) break
  }
  const plan = planSpotCheck({ packs, lfs }, options.samples ?? SPOT_CHECK_SAMPLES, options.random)
  const probe = await options
    .fetch(new Request(`${options.mirrorUrl.replace(/\/+$/, '')}/objects/info/packs`, { method: 'HEAD', ...(options.authorization ? { headers: { Authorization: options.authorization } } : {}) }))
    .catch(() => null)
  await probe?.body?.cancel()
  if (!probe?.ok) return { at: options.now.toISOString(), ok: true, samples: 0, skipped: plan.length, problems: [] }
  const problems: string[] = []
  let skipped = 0
  let checked = 0
  for (const sample of plan) {
    const key = sample.kind === 'pack' ? packKey(options.repo, sample.name) : `${lfsPrefix(options.repo)}objects/${sample.oid.slice(0, 2)}/${sample.oid.slice(2, 4)}/${sample.oid}`
    const own = await options.storage.get(key, { offset: sample.offset, length: sample.length })
    if (!own) continue
    const expected = sha256Hex(await readAll(own.body))
    const label = `${sample.kind === 'pack' ? sample.name : sample.oid} @${sample.offset}+${sample.length}`
    let response: Response
    try {
      response = await options.fetch(
        new Request(sampleUrl(options.mirrorUrl, sample), {
          headers: { Range: `bytes=${sample.offset}-${sample.offset + sample.length - 1}`, ...(options.authorization ? { Authorization: options.authorization } : {}) },
        }),
      )
    } catch (error) {
      problems.push(`${label}: ${(error as Error).message}`)
      continue
    }
    if (response.status === 404 && sample.kind === 'pack') {
      await response.body?.cancel()
      skipped++
      continue
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      skipped++
      continue
    }
    if (response.status !== 206) {
      await response.body?.cancel()
      problems.push(`${label}: HTTP ${response.status} instead of 206`)
      continue
    }
    const actual = sha256Hex(new Uint8Array(await response.arrayBuffer()))
    checked++
    if (actual !== expected) problems.push(`${label}: bytes differ`)
  }
  return { at: options.now.toISOString(), ok: problems.length === 0, samples: checked, skipped, problems }
}

export const runSpotCheck = async (federation: MirrorFederation, repository: string, issuer: string): Promise<void> => {
  const attestation = await federation.verification.attestation(repository, issuer)
  if (!attestation?.url) return
  const repo = repositoryOf(repository)
  const mirror = parseUpstreamUrl(attestation.url, issuer)
  const token = await mintInstanceToken({ key: federation.instanceKey, issuer: federation.issuer, audience: issuer, repositories: [mirror.repository] })
  const result = await spotCheck({
    storage: federation.storage,
    repo,
    mirrorUrl: attestation.url,
    fetch: (request) => (federation.fetch ?? globalThis.fetch)(request),
    authorization: `Bearer ${token}`,
    now: (federation.now ?? (() => new Date()))(),
  })
  await federation.verification.recordSpotCheck(repository, { issuer, ...result })
}

export type MirrorOverviewEntry = {
  readonly issuer: string
  readonly subscribed: boolean
  readonly url: string | null
  readonly state: string
  readonly lagSeconds: number | null
  readonly alarms: readonly string[]
  readonly attestation: {
    readonly checksum: string
    readonly refs: number
    readonly namespace: string
    readonly syncedAt: string
    readonly receivedAt: string
    readonly alarms: number
    readonly pending: number
    readonly deepCheck?: { readonly at: string; readonly ok: boolean }
    readonly token: string
  } | null
  readonly spotCheck: Omit<StoredSpotCheck, 'issuer'> | null
}

export type MirrorOverview = {
  readonly repository: string
  readonly generatedAt: string
  readonly checksum: string
  readonly refs: number
  readonly mirrors: readonly MirrorOverviewEntry[]
  readonly upstreams: readonly {
    readonly remote: string
    readonly url: string
    readonly mode: string
    readonly detached: boolean
    readonly lastSuccessAt: string | null
    readonly lastError: string | null
    readonly checksum: string
    readonly refs: number
    readonly alarms: number
    readonly pending: number
    readonly deepCheck: { readonly at: string; readonly ok: boolean } | null
  }[]
}

export type OverviewContext = {
  readonly storage: Storage
  readonly verification: MirrorVerificationStore
  readonly subscribers: (repository: string) => Promise<readonly { readonly issuer: string }[]>
  readonly readOf?: (issuer: string) => Promise<InstanceRead>
  readonly now: Date
}

export const mirrorOverview = async (context: OverviewContext, repo: RepositoryName): Promise<MirrorOverview | null> => {
  const refs = await readRefs(context.storage, repo)
  if (!refs) return null
  const repository = nameOf(repo)
  await recordChecksums(context.verification, context.storage, repo)
  const attestations = await context.verification.attestations(repository)
  const spotChecks = await context.verification.spotChecks(repository)
  const subscribed = new Set((await context.subscribers(repository)).map((subscription) => subscription.issuer))
  const issuers = [...new Set([...subscribed, ...attestations.map((attestation) => attestation.issuer)])].sort()
  const histories = new Map<string, Awaited<ReturnType<MirrorVerificationStore['checksumHistory']>>>()
  const historyOf = async (namespace: string) => {
    let history = histories.get(namespace)
    if (!history) {
      history = await context.verification.checksumHistory(repository, namespace)
      histories.set(namespace, history)
    }
    return history
  }
  const mirrors: MirrorOverviewEntry[] = []
  for (const issuer of issuers) {
    const attestation = attestations.find((candidate) => candidate.issuer === issuer) ?? null
    const spot = spotChecks.find((candidate) => candidate.issuer === issuer) ?? null
    const { key, current } = await viewChecksum(context.verification, repository, refs.state, attestation?.namespace ?? '', issuer, (await context.readOf?.(issuer)) ?? null)
    const evaluation = evaluateMirror({
      current,
      history: await historyOf(key),
      attestation,
      spotCheck: spot,
      now: context.now,
    })
    mirrors.push({
      issuer,
      subscribed: subscribed.has(issuer),
      url: attestation?.url ?? null,
      ...evaluation,
      attestation: attestation
        ? {
            checksum: attestation.checksum,
            refs: attestation.refs,
            namespace: attestation.namespace,
            syncedAt: attestation.syncedAt,
            receivedAt: attestation.receivedAt,
            alarms: attestation.alarms,
            pending: attestation.pending,
            ...(attestation.deepCheck ? { deepCheck: attestation.deepCheck } : {}),
            token: attestation.token,
          }
        : null,
      spotCheck: spot ? { at: spot.at, ok: spot.ok, samples: spot.samples, skipped: spot.skipped, problems: spot.problems } : null,
    })
  }
  const upstreams = []
  for (const config of await listMirrors(context.storage, repo)) {
    const status = await readMirrorStatus(context.storage, repo, config.remote)
    const held = namespacedChecksum(refs.state, `upstream/${config.remote}/`)
    upstreams.push({
      remote: config.remote,
      url: config.url,
      mode: config.mode,
      detached: config.detachedAt !== undefined,
      lastSuccessAt: status?.lastSuccessAt ?? null,
      lastError: status?.lastRun?.ok === false ? (status.lastRun.error ?? 'failed') : null,
      checksum: held.checksum,
      refs: held.refs,
      alarms: status?.alarms.length ?? 0,
      pending: (status?.lfsPending.length ?? 0) + (status?.pendingPacks?.length ?? 0),
      deepCheck: status?.lastDeepCheck ? { at: status.lastDeepCheck.at, ok: status.lastDeepCheck.ok } : null,
    })
  }
  const own = namespacedChecksum(refs.state)
  return { repository, generatedAt: context.now.toISOString(), checksum: own.checksum, refs: own.refs, mirrors, upstreams }
}

export const signOverview = (key: SigningKey, issuer: string, overview: MirrorOverview, now: Date): Promise<string> =>
  signMirrorOverview(
    key,
    issuer,
    {
      repository: overview.repository,
      checksum: overview.checksum,
      refs: overview.refs,
      mirrors: overview.mirrors.map((mirror) => ({ issuer: mirror.issuer, state: mirror.state, lag_seconds: mirror.lagSeconds, alarms: mirror.alarms, checksum: mirror.attestation?.checksum ?? null })),
    },
    now.getTime(),
  )
