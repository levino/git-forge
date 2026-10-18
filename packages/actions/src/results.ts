import type { Database } from '@git-forge/accounts'
import { advertisedRefs, readRefs, type Storage } from '@git-forge/core'
import { artifactByName, artifactExpiry, artifactFilename, type ArtifactRow, createArtifact, DEFAULT_ARTIFACT_RETENTION_DAYS, deleteArtifact, finalizeArtifact, listArtifacts, validArtifactName } from './artifacts.ts'
import { BlobError, blobUrl, commitRanges, getBlob, handleBlobRequest, issueBlobGrant, rangeBlockId, stageBlock } from './blobs.ts'
import {
  type CacheEntryRow,
  type CacheLimits,
  cacheScopes,
  DEFAULT_CACHE_LIMITS,
  evictCacheEntries,
  finalizeCache,
  findCache,
  getCacheEntry,
  listCaches,
  MAX_CACHE_KEYS,
  reserveCache,
  uploadingCacheFor,
  validCacheKey,
  validCacheVersion,
} from './cache.ts'
import { type JobDefinition, jobDefinitionOf, type RunDefinition, runDefinitionOf } from './definitions.ts'
import { ID_TOKEN_PATH, idTokenAllowed, idTokenClaims, idTokenDiscovery, idTokenJwks, type IdTokenKey, type RepositoryFacts, signIdToken, TOKEN_SERVICE_PATH, tokenIssuer } from './oidc.ts'
import { getJobById, getRun, type JobRow, type RunRow, verifyToken } from './store.ts'

export type ResultsServiceOptions = {
  readonly db: Database
  readonly storage: Storage
  readonly serverUrl?: string
  readonly idTokenKeys?: readonly IdTokenKey[]
  readonly repositoryFacts?: (owner: string, repo: string) => Promise<RepositoryFacts | null>
  readonly cacheLimits?: CacheLimits
  readonly artifactRetentionDays?: number
  readonly now?: () => number
}

export const CACHE_SERVICE_PATH = '/_services/cache/'

export const TWIRP_PATH = '/twirp/'

const CACHE_SERVICE = 'github.actions.results.api.v1.CacheService'

const ARTIFACT_SERVICE = 'github.actions.results.api.v1.ArtifactService'

const UPLOAD_GRANT_MS = 6 * 60 * 60 * 1000

const DOWNLOAD_GRANT_MS = 60 * 60 * 1000

export const resultsEndpointData = (serverUrl: string, idTokenUrl: string | null): Record<string, string> => ({
  CacheServerUrl: `${serverUrl}${CACHE_SERVICE_PATH}`,
  ResultsServiceUrl: `${serverUrl}/`,
  ...(idTokenUrl ? { GenerateIdTokenUrl: idTokenUrl } : {}),
})

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } })

const TWIRP_STATUS: Record<string, number> = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  bad_route: 404,
  already_exists: 409,
  failed_precondition: 412,
  internal: 500,
}

const twirpError = (code: keyof typeof TWIRP_STATUS, msg: string) => json(TWIRP_STATUS[code]!, { code, msg })

type Authenticated = {
  readonly job: JobRow
  readonly run: RunRow
  readonly runDefinition: RunDefinition | null
  readonly jobDefinition: JobDefinition
}

type Context = {
  readonly options: ResultsServiceOptions
  readonly request: Request
  readonly url: URL
  readonly now: number
  readonly serverUrl: string
}

const bearer = (request: Request): string | null => {
  const [scheme, value] = (request.headers.get('Authorization') ?? '').trim().split(/\s+/, 2) as [string, string | undefined]
  return value && scheme.toLowerCase() === 'bearer' ? value : null
}

const authenticate = async (context: Context): Promise<Authenticated | null> => {
  const token = bearer(context.request)
  if (!token) return null
  const grant = await verifyToken(context.options.db, token, 'runtime', context.now)
  if (!grant?.job_id) return null
  const job = await getJobById(context.options.db, grant.job_id)
  if (!job || job.status === 'completed') return null
  const run = await getRun(context.options.db, job.run_id)
  if (!run || run.owner !== grant.owner || run.repo !== grant.repo) return null
  return { job, run, runDefinition: runDefinitionOf(run), jobDefinition: jobDefinitionOf(job) }
}

type Body = Readonly<Record<string, unknown>>

const readBody = async (request: Request): Promise<Body | null> => {
  try {
    const value: unknown = await request.json()
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Body) : null
  } catch {
    return null
  }
}

const camel = (name: string): string => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())

const field = (body: Body, name: string): unknown => body[name] ?? body[camel(name)]

const stringField = (body: Body, name: string): string | null => {
  const value = field(body, name)
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && typeof (value as { value?: unknown }).value === 'string') return (value as { value: string }).value
  return null
}

const integerField = (body: Body, name: string): number | null => {
  const value = field(body, name)
  const raw = typeof value === 'object' && value !== null ? (value as { value?: unknown }).value : value
  const number = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null
}

const timestampField = (body: Body, name: string): number | null => {
  const value = stringField(body, name)
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

const defaultBranch = async (storage: Storage, owner: string, repo: string): Promise<string | null> => {
  const stored = await readRefs(storage, { owner, name: repo })
  return stored ? advertisedRefs(stored.state).head : null
}

const scopesFor = async (context: Context, auth: Authenticated): Promise<string[]> => {
  const pullRequest = auth.runDefinition?.payload['pull_request'] as { readonly base?: { readonly ref?: string } } | undefined
  return cacheScopes({
    ref: auth.run.ref,
    baseRef: typeof pullRequest?.base?.ref === 'string' ? pullRequest.base.ref : null,
    defaultBranch: await defaultBranch(context.options.storage, auth.run.owner, auth.run.repo),
  })
}

const limitsOf = (context: Context): CacheLimits => context.options.cacheLimits ?? DEFAULT_CACHE_LIMITS

const downloadUrl = async (context: Context, entry: CacheEntryRow, jobId: string): Promise<string> =>
  blobUrl(context.serverUrl, await issueBlobGrant(context.options.db, { blobId: entry.blob_id, access: 'read', jobId, ttlMs: DOWNLOAD_GRANT_MS }, context.now))

const finalizeUploadedCache = async (context: Context, entry: CacheEntryRow, size: number): Promise<string | null> => {
  const blob = await getBlob(context.options.db, entry.blob_id)
  if (!blob || blob.committed_at === null) return 'the cache archive was not uploaded'
  if (blob.size !== size) return `the uploaded archive has ${blob.size} bytes, not ${size}`
  if (size > limitsOf(context).entryBytes) {
    await evictCacheEntries(context.options.db, [entry.id], context.now)
    return `cache entries are limited to ${limitsOf(context).entryBytes} bytes`
  }
  return (await finalizeCache(context.options.db, entry, size, context.now)) ? null : 'the cache entry is already finalized'
}

const cacheTwirp = async (context: Context, auth: Authenticated, method: string, body: Body): Promise<Response> => {
  const { db } = context.options
  const { run, job } = auth
  const key = stringField(body, 'key') ?? ''
  const version = stringField(body, 'version') ?? ''
  if (!validCacheKey(key) || !validCacheVersion(version)) return twirpError('invalid_argument', 'invalid cache key or version')
  if (method === 'CreateCacheEntry') {
    const reserved = await reserveCache(db, { owner: run.owner, repo: run.repo, scope: run.ref, key, version, jobId: job.id }, context.now, limitsOf(context))
    if (!reserved) return json(200, { ok: false, message: `a cache entry for key ${key} already exists or is being created` })
    const token = await issueBlobGrant(db, { blobId: reserved.blob.id, access: 'write', jobId: job.id, ttlMs: UPLOAD_GRANT_MS }, context.now)
    return json(200, { ok: true, signed_upload_url: blobUrl(context.serverUrl, token) })
  }
  if (method === 'FinalizeCacheEntryUpload') {
    const size = integerField(body, 'size_bytes')
    const entry = await uploadingCacheFor(db, { owner: run.owner, repo: run.repo, key, version, jobId: job.id })
    if (!entry || size === null) return json(200, { ok: false, message: 'no cache entry is being uploaded for this key and version' })
    const problem = await finalizeUploadedCache(context, entry, size)
    return json(200, problem ? { ok: false, message: problem } : { ok: true, entry_id: String(entry.id) })
  }
  if (method === 'GetCacheEntryDownloadURL') {
    const restoreKeys = (Array.isArray(field(body, 'restore_keys')) ? (field(body, 'restore_keys') as unknown[]) : []).filter((entry): entry is string => typeof entry === 'string')
    if (restoreKeys.length + 1 > MAX_CACHE_KEYS || !restoreKeys.every(validCacheKey)) return twirpError('invalid_argument', 'invalid restore keys')
    const entry = await findCache(db, { owner: run.owner, repo: run.repo, version, scopes: await scopesFor(context, auth), primaryKey: key, restoreKeys }, context.now)
    if (!entry) return json(200, { ok: false })
    return json(200, { ok: true, signed_download_url: await downloadUrl(context, entry, job.id), matched_key: entry.key })
  }
  return twirpError('bad_route', `unknown method ${method}`)
}

const iso = (ms: number): string => new Date(ms).toISOString()

const monolithArtifact = (artifact: ArtifactRow) => ({
  workflow_run_backend_id: String(artifact.run_id),
  workflow_job_run_backend_id: artifact.job_id,
  database_id: String(artifact.id),
  name: artifact.name,
  size: String(artifact.size ?? 0),
  created_at: iso(artifact.created_at),
  ...(artifact.digest ? { digest: artifact.digest } : {}),
})

const artifactTwirp = async (context: Context, auth: Authenticated, method: string, body: Body): Promise<Response> => {
  const { db } = context.options
  const { run, job } = auth
  const runBackendId = stringField(body, 'workflow_run_backend_id')
  const jobBackendId = stringField(body, 'workflow_job_run_backend_id')
  if (runBackendId !== String(run.id)) return twirpError('permission_denied', 'the workflow run does not match the token')
  if (method === 'ListArtifacts') {
    const id = integerField(body, 'id_filter')
    const name = stringField(body, 'name_filter')
    const artifacts = await listArtifacts(db, run.owner, run.repo, { runId: run.id, ...(id !== null ? { id } : {}), ...(name !== null ? { name } : {}) }, context.now)
    return json(200, { artifacts: artifacts.map(monolithArtifact) })
  }
  const name = stringField(body, 'name') ?? ''
  if (method === 'GetSignedArtifactURL') {
    const artifact = await artifactByName(db, run.id, name)
    if (!artifact || artifact.finalized_at === null || artifact.expires_at <= context.now) return twirpError('not_found', `artifact ${name} not found`)
    const token = await issueBlobGrant(db, { blobId: artifact.blob_id, access: 'read', jobId: job.id, filename: artifactFilename(artifact), ttlMs: DOWNLOAD_GRANT_MS }, context.now)
    return json(200, { signed_url: blobUrl(context.serverUrl, token, artifactFilename(artifact)) })
  }
  if (method === 'DeleteArtifact') {
    const artifact = await artifactByName(db, run.id, name)
    if (!artifact || !(await deleteArtifact(db, artifact.id, context.now))) return twirpError('not_found', `artifact ${name} not found`)
    return json(200, { ok: true, artifact_id: String(artifact.id) })
  }
  if (jobBackendId !== job.id) return twirpError('permission_denied', 'the workflow job does not match the token')
  if (method === 'CreateArtifact') {
    if (!validArtifactName(name)) return twirpError('invalid_argument', `invalid artifact name ${JSON.stringify(name)}`)
    const version = integerField(body, 'version') ?? 4
    const retentionDays = context.options.artifactRetentionDays ?? DEFAULT_ARTIFACT_RETENTION_DAYS
    const created = await createArtifact(
      db,
      {
        owner: run.owner,
        repo: run.repo,
        runId: run.id,
        jobId: job.id,
        name,
        version,
        mimeType: stringField(body, 'mime_type'),
        expiresAt: artifactExpiry(context.now, timestampField(body, 'expires_at'), retentionDays),
      },
      context.now,
    )
    if (!created) return twirpError('already_exists', `an artifact named ${name} already exists in this workflow run`)
    const token = await issueBlobGrant(db, { blobId: created.blob.id, access: 'write', jobId: job.id, ttlMs: UPLOAD_GRANT_MS }, context.now)
    return json(200, { ok: true, signed_upload_url: blobUrl(context.serverUrl, token) })
  }
  if (method === 'FinalizeArtifact') {
    const artifact = await artifactByName(db, run.id, name)
    const size = integerField(body, 'size')
    if (!artifact || artifact.job_id !== job.id || size === null) return twirpError('not_found', `artifact ${name} is not being uploaded by this job`)
    const blob = await getBlob(db, artifact.blob_id)
    if (!blob || blob.committed_at === null) return twirpError('failed_precondition', `artifact ${name} was not uploaded`)
    if (blob.size !== size) return twirpError('invalid_argument', `artifact ${name} has ${blob.size} bytes, not ${size}`)
    if (!(await finalizeArtifact(db, artifact, size, stringField(body, 'hash'), context.now))) return twirpError('failed_precondition', `artifact ${name} is already finalized`)
    return json(200, { ok: true, artifact_id: String(artifact.id) })
  }
  return twirpError('bad_route', `unknown method ${method}`)
}

const twirpRoute = async (context: Context): Promise<Response> => {
  const [service, method] = context.url.pathname.slice(TWIRP_PATH.length).split('/')
  if (context.request.method !== 'POST' || !method || (service !== CACHE_SERVICE && service !== ARTIFACT_SERVICE)) return twirpError('bad_route', 'no such twirp method')
  if (!(context.request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return twirpError('bad_route', 'only the JSON encoding is supported')
  const auth = await authenticate(context)
  if (!auth) return twirpError('unauthenticated', 'a valid runtime token of a running job is required')
  const body = await readBody(context.request)
  if (!body) return twirpError('invalid_argument', 'expected a JSON object')
  return service === CACHE_SERVICE ? cacheTwirp(context, auth, method, body) : artifactTwirp(context, auth, method, body)
}

const v1Error = (status: number, message: string) => json(status, { message, typeKey: 'ArtifactCacheException' })

const v1Entry = async (context: Context, entry: CacheEntryRow, jobId: string) => ({
  scope: entry.scope,
  cacheKey: entry.key,
  cacheVersion: entry.version,
  creationTime: iso(entry.created_at),
  archiveLocation: await downloadUrl(context, entry, jobId),
})

const parseContentRange = (header: string | null): { readonly start: number; readonly end: number } | null => {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header?.trim() ?? '')
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start ? { start, end } : null
}

const cacheV1Route = async (context: Context): Promise<Response> => {
  const { db, storage } = context.options
  const segments = context.url.pathname.slice(CACHE_SERVICE_PATH.length).split('/').filter((segment) => segment !== '')
  if (segments[0] !== '_apis' || segments[1] !== 'artifactcache') return v1Error(404, 'not found')
  const auth = await authenticate(context)
  if (!auth) return v1Error(401, 'a valid runtime token of a running job is required')
  const { run, job } = auth
  const method = context.request.method
  const [resource, id] = segments.slice(2)
  if (resource === 'cache' && !id && method === 'GET') {
    const keys = (context.url.searchParams.get('keys') ?? '').split(',').filter((key) => key !== '')
    const version = context.url.searchParams.get('version') ?? ''
    if (keys.length === 0 || keys.length > MAX_CACHE_KEYS || !keys.every(validCacheKey) || !validCacheVersion(version)) return v1Error(400, 'invalid keys or version')
    const entry = await findCache(db, { owner: run.owner, repo: run.repo, version, scopes: await scopesFor(context, auth), primaryKey: keys[0]!, restoreKeys: keys.slice(1) }, context.now)
    return entry ? json(200, await v1Entry(context, entry, job.id)) : new Response(null, { status: 204 })
  }
  if (resource === 'caches' && !id && method === 'GET') {
    const key = context.url.searchParams.get('key') ?? undefined
    const entries = await listCaches(db, run.owner, run.repo, key ? { key } : {})
    return json(200, { totalCount: entries.length, artifactCaches: entries.map((entry) => ({ scope: entry.scope, cacheKey: entry.key, cacheVersion: entry.version, creationTime: iso(entry.created_at) })) })
  }
  if (resource === 'caches' && !id && method === 'POST') {
    const body = await readBody(context.request)
    const key = typeof body?.['key'] === 'string' ? body['key'] : ''
    const version = typeof body?.['version'] === 'string' ? body['version'] : ''
    const size = typeof body?.['cacheSize'] === 'number' ? body['cacheSize'] : null
    if (!validCacheKey(key) || !validCacheVersion(version)) return v1Error(400, 'invalid key or version')
    if (size !== null && size > limitsOf(context).entryBytes) return v1Error(400, `cache size of ${size} bytes is over the limit of ${limitsOf(context).entryBytes} bytes`)
    const reserved = await reserveCache(db, { owner: run.owner, repo: run.repo, scope: run.ref, key, version, jobId: job.id }, context.now, limitsOf(context))
    if (!reserved) return v1Error(409, `cache entry with key ${key} and version ${version} already exists or is being created`)
    return json(201, { cacheId: reserved.entry.id })
  }
  const entry = id && /^\d+$/.test(id) ? await getCacheEntry(db, Number(id)) : null
  if (resource !== 'caches' || !entry || entry.owner !== run.owner || entry.repo !== run.repo || entry.job_id !== job.id || entry.evicted_at !== null) return v1Error(404, 'cache entry not found')
  if (entry.finalized_at !== null) return v1Error(409, 'the cache entry is already committed')
  if (method === 'PATCH') {
    const range = parseContentRange(context.request.headers.get('Content-Range'))
    if (!range || range.end >= limitsOf(context).entryBytes) return v1Error(400, 'expected a Content-Range of bytes start-end/*')
    const blob = await getBlob(db, entry.blob_id)
    if (!blob) return v1Error(404, 'cache entry not found')
    await stageBlock(db, storage, blob, rangeBlockId(range.start, range.end), context.request.body, range.end - range.start + 1, context.now)
    return new Response(null, { status: 204 })
  }
  if (method === 'POST') {
    const body = await readBody(context.request)
    const size = typeof body?.['size'] === 'number' ? body['size'] : null
    const blob = await getBlob(db, entry.blob_id)
    if (size === null || !blob) return v1Error(400, 'expected { size }')
    await commitRanges(db, blob, size, context.now)
    const problem = await finalizeUploadedCache(context, entry, size)
    return problem ? v1Error(400, problem) : new Response(null, { status: 204 })
  }
  return v1Error(405, 'method not allowed')
}

const idTokenRoute = async (context: Context): Promise<Response> => {
  const { options } = context
  const key = options.idTokenKeys?.[0]
  if (!key) return json(404, { message: 'ID tokens are not configured on this forge' })
  if (context.request.method !== 'GET' && context.request.method !== 'POST') return json(405, { message: 'method not allowed' })
  const auth = await authenticate(context)
  if (!auth) return json(401, { message: 'a valid runtime token of a running job is required' })
  if (!idTokenAllowed(auth.run, auth.runDefinition, auth.jobDefinition)) return json(403, { message: 'the job does not have the id-token: write permission' })
  const audience = context.url.searchParams.get('audience') || `${context.serverUrl}/${auth.run.owner}`
  const claims = idTokenClaims({
    issuer: tokenIssuer(context.serverUrl),
    audience,
    serverUrl: context.serverUrl,
    run: auth.run,
    job: auth.job,
    jobKey: auth.job.job_key,
    payload: auth.runDefinition?.payload ?? {},
    repository: (await options.repositoryFacts?.(auth.run.owner, auth.run.repo)) ?? null,
    now: context.now,
    jti: crypto.randomUUID(),
  })
  return json(200, { value: await signIdToken(key, claims) }, { 'Cache-Control': 'no-store' })
}

const tokenServiceRoute = async (context: Context): Promise<Response> => {
  const keys = context.options.idTokenKeys ?? []
  const path = context.url.pathname
  if (path === ID_TOKEN_PATH) return idTokenRoute(context)
  if (keys.length === 0 || (context.request.method !== 'GET' && context.request.method !== 'HEAD')) return json(404, { message: 'not found' })
  const cache = { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' }
  if (path === `${TOKEN_SERVICE_PATH}/.well-known/openid-configuration`) return json(200, idTokenDiscovery(context.serverUrl, keys), cache)
  if (path === `${TOKEN_SERVICE_PATH}/.well-known/jwks`) return json(200, idTokenJwks(keys), cache)
  return json(404, { message: 'not found' })
}

export const isResultsServicePath = (pathname: string): boolean =>
  pathname.startsWith(TWIRP_PATH) || pathname.startsWith(CACHE_SERVICE_PATH) || pathname.startsWith('/_services/results/') || pathname === TOKEN_SERVICE_PATH || pathname.startsWith(`${TOKEN_SERVICE_PATH}/`)

export const handleResultsService = async (request: Request, options: ResultsServiceOptions): Promise<Response | null> => {
  const url = new URL(request.url)
  if (!isResultsServicePath(url.pathname)) return null
  const now = (options.now ?? Date.now)()
  const context: Context = { options, request, url, now, serverUrl: (options.serverUrl ?? url.origin).replace(/\/+$/, '') }
  try {
    if (url.pathname.startsWith(TWIRP_PATH)) return await twirpRoute(context)
    if (url.pathname.startsWith(CACHE_SERVICE_PATH)) return await cacheV1Route(context)
    if (url.pathname.startsWith(TOKEN_SERVICE_PATH)) return await tokenServiceRoute(context)
    return (await handleBlobRequest(request, options.db, options.storage, now)) ?? json(404, { message: 'not found' })
  } catch (error) {
    if (error instanceof BlobError) return url.pathname.startsWith(TWIRP_PATH) ? twirpError('invalid_argument', error.message) : v1Error(error.status, error.message)
    throw error
  }
}
