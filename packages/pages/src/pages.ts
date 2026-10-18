import { atLeast, checkRepositoryAccess, type Database, type Principal, type RepositoryDirectory, type RepositorySubject, type Role, type UserPrincipal } from '@git-forge/accounts'
import { type DigestFactory, isValidName, type PushOutcome, type RepositoryName, resolveCommitish, type Storage, ZERO_ID } from '@git-forge/core'
import { ApiError, apiUrl, empty, json, pagination, linkHeader, readJson, userObject } from '@git-forge/notifications'
import { type BuildLimits, readManifest } from './deploy.ts'
import { type ArtifactSource, isPagesJob, type PagesJob, runDeployment } from './deployments.ts'
import { customDomain, isPagesUrl, type PagesHosts, pagesUrl } from './hosts.ts'
import { AUTHORIZE_PATH, CALLBACK_PATH, handlePagesRequest, isPagesRequest } from './serve.ts'
import { type BuildType, type Creator, createPagesStore, type DeploymentRow, type DeploymentSource, type PagesStore, type SiteInput, type SiteRow } from './store.ts'

export type PagesOptions = {
  readonly db: Database
  readonly storage: Storage
  readonly directory: RepositoryDirectory
  readonly hosts: PagesHosts | null
  readonly forgeUrl: string | null
  readonly baseUrl: (request: Request) => string
  readonly authenticate: (request: Request) => Promise<Principal | null>
  readonly authenticateToken: (request: Request) => Promise<Principal | null>
  readonly sessionUser: (request: Request) => Promise<UserPrincipal | null>
  readonly isInstanceAdmin: (userId: string) => Promise<boolean>
  readonly jobTokenRepository?: (request: Request) => Promise<RepositoryName | null>
  readonly artifacts?: ArtifactSource
  readonly schedule?: (job: PagesJob) => Promise<void>
  readonly limits?: BuildLimits
  readonly digests?: DigestFactory
  readonly maxAgeSeconds?: number
  readonly now?: () => number
  readonly log?: (event: Record<string, unknown>) => void
}

export type Pages = {
  readonly isPagesRequest: (request: Request) => boolean
  readonly serve: (request: Request) => Promise<Response | null>
  readonly api: (request: Request) => Promise<Response | null>
  readonly onPush: (repo: RepositoryName, outcome: PushOutcome, principal: Principal | null) => Promise<void>
  readonly runJob: (job: PagesJob) => Promise<void>
  readonly store: PagesStore
}

export const DEFAULT_PAGES_MAX_AGE_SECONDS = 60

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

const DOCS = 'https://docs.github.com/rest/pages'

const TAR_TYPES = ['application/x-tar', 'application/tar', 'application/gzip', 'application/x-gzip', 'application/octet-stream']

const iso = (value: number): string => new Date(value).toISOString()

const creatorOf = (principal: Principal | null): Creator => {
  switch (principal?.kind) {
    case 'user':
      return { kind: 'user', id: principal.id, login: principal.login }
    case 'app':
      return { kind: 'app', id: principal.id, login: `${principal.slug}[bot]` }
    case 'instance':
      return { kind: 'instance', id: principal.issuer, login: null }
    default:
      return { kind: 'system', id: null, login: null }
  }
}

const buildStatus = (deployment: DeploymentRow | null): string | null => {
  if (!deployment) return null
  return { queued: 'queued', in_progress: 'building', succeed: 'built', failed: 'errored', cancelled: 'errored' }[deployment.status]
}

const deploymentStatus = (deployment: DeploymentRow): string =>
  ({ queued: 'deployment_queued', in_progress: 'deployment_in_progress', succeed: 'succeed', failed: 'deployment_failed', cancelled: 'deployment_cancelled' })[deployment.status]

type Access = { readonly principal: Principal | null; readonly repository: RepositorySubject }

const parseSource = (value: unknown, current: SiteRow | null): { readonly branch: string; readonly path: '/' | '/docs' } | null | undefined => {
  if (value === undefined) return undefined
  if (value === null) return null
  let branch: unknown
  let path: unknown = current?.source_path ?? '/'
  if (typeof value === 'string') {
    const [name, folder] = value.trim().split(/\s+/)
    branch = name
    if (folder !== undefined) path = folder
  } else if (typeof value === 'object') {
    branch = (value as { branch?: unknown }).branch
    path = (value as { path?: unknown }).path ?? '/'
  }
  if (typeof branch !== 'string' || !BRANCH.test(branch) || branch.includes('..')) throw new ApiError(422, 'source.branch must be a branch name')
  if (path !== '/' && path !== '/docs') throw new ApiError(422, 'source.path must be "/" or "/docs"')
  return { branch, path }
}

const parseBuildType = (value: unknown): BuildType | undefined => {
  if (value === undefined || value === null) return undefined
  if (value !== 'legacy' && value !== 'workflow') throw new ApiError(422, 'build_type must be legacy or workflow')
  return value
}

export const createPages = (options: PagesOptions): Pages => {
  const { storage, db } = options
  const now = options.now ?? Date.now
  const store = createPagesStore(db, now)
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_PAGES_MAX_AGE_SECONDS
  const deploymentContext = {
    storage,
    store,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.digests ? { digests: options.digests } : {}),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.log ? { log: options.log } : {}),
  }

  const dispatch = async (repository: RepositorySubject, deployment: DeploymentRow): Promise<void> => {
    const job: PagesJob = { kind: 'pages-deploy', owner: repository.owner, name: repository.name, repositoryId: repository.id, deployment: deployment.id }
    if (options.schedule) await options.schedule(job)
    else await runDeployment(deploymentContext, repository, deployment)
  }

  const deployBranch = async (repository: RepositorySubject, site: SiteRow, principal: Principal | null, commit?: string): Promise<DeploymentRow | null> => {
    if (site.build_type !== 'legacy' || !site.source_branch) return null
    const ref = `refs/heads/${site.source_branch}`
    const sha = commit ?? (await resolveCommitish(storage, { owner: repository.owner, name: repository.name }, ref))
    if (!sha) return null
    const deployment = await store.createDeployment(repository.id, { source: 'branch', ref, commitSha: sha }, creatorOf(principal))
    await dispatch(repository, deployment)
    return deployment
  }

  const access = async (request: Request, owner: string, name: string, required: Role, allowJobToken = false): Promise<Access> => {
    if (!isValidName(owner) || !isValidName(name)) throw new ApiError(404, 'Not Found')
    if (allowJobToken && options.jobTokenRepository) {
      const repo = await options.jobTokenRepository(request)
      if (repo && repo.owner.toLowerCase() === owner.toLowerCase() && repo.name.toLowerCase() === name.toLowerCase()) {
        const repository = await options.directory.findRepository(owner, name)
        if (repository) return { principal: null, repository }
      }
    }
    const principal = await options.authenticate(request)
    if (!principal) throw new ApiError(401, 'Bad credentials', { 'WWW-Authenticate': 'Bearer' })
    const check = await checkRepositoryAccess(options.directory, principal, { owner, name }, 'read')
    const repository = check.repository
    const instanceAdmin = principal.kind === 'user' && (await options.isInstanceAdmin(principal.id))
    if (!repository || (check.decision !== 'allow' && !instanceAdmin)) {
      if (check.decision === 'unauthenticated') throw new ApiError(401, 'Requires authentication', { 'WWW-Authenticate': 'Bearer' })
      throw new ApiError(404, 'Not Found')
    }
    const level = instanceAdmin ? (principal.kind === 'user' ? (principal.limits?.ceiling ?? 'admin') : check.access) : check.access
    if (level === 'none' || !atLeast(level, required)) {
      if (principal.kind === 'anonymous') throw new ApiError(401, 'Requires authentication', { 'WWW-Authenticate': 'Bearer' })
      throw new ApiError(403, required === 'admin' ? 'Must have admin rights to Repository.' : 'Must have push access to repository')
    }
    return { principal, repository }
  }

  const repoPath = (repository: RepositorySubject): string => `/repos/${repository.owner}/${repository.name}`

  const siteJson = async (base: string, repository: RepositorySubject, site: SiteRow) => {
    const [latest] = await store.deployments(repository.id, null, 1, 0)
    const active = await store.activeDeployment(repository.id)
    const manifest = active?.manifest ? await readManifest(storage, { owner: repository.owner, name: repository.name }, active.manifest) : null
    const repo = { owner: repository.owner, name: repository.name }
    return {
      url: apiUrl(base, `${repoPath(repository)}/pages`),
      status: buildStatus(latest ?? null),
      cname: options.hosts ? customDomain(options.hosts, repo) : null,
      custom_404: manifest ? '404.html' in manifest.files : false,
      html_url: pagesUrl(options.hosts, repo),
      build_type: site.build_type,
      source: site.source_branch ? { branch: site.source_branch, path: site.source_path } : null,
      public: repository.visibility === 'public',
      https_enforced: options.hosts?.scheme === 'https',
      protected_domain_state: null,
      pending_domain_unverified_at: null,
      active_deployment: active ? { id: active.id, commit: active.commit_sha, files: active.file_count, bytes: active.total_bytes } : null,
    }
  }

  const buildJson = (base: string, repository: RepositorySubject, deployment: DeploymentRow) => ({
    url: apiUrl(base, `${repoPath(repository)}/pages/builds/${deployment.id}`),
    status: buildStatus(deployment),
    error: { message: deployment.error },
    pusher: userObject(base, deployment.creator_login, deployment.creator_id),
    commit: deployment.commit_sha,
    duration: Math.max(0, deployment.updated_at - deployment.created_at),
    created_at: iso(deployment.created_at),
    updated_at: iso(deployment.updated_at),
  })

  const deploymentJson = (base: string, repository: RepositorySubject, deployment: DeploymentRow) => ({
    id: deployment.id,
    status: deploymentStatus(deployment),
    status_url: apiUrl(base, `${repoPath(repository)}/pages/deployments/${deployment.id}`),
    page_url: pagesUrl(options.hosts, { owner: repository.owner, name: repository.name }),
    preview_url: '',
    source: deployment.source,
    commit: deployment.commit_sha,
    error: deployment.error,
    error_count: deployment.status === 'failed' ? 1 : 0,
    created_at: iso(deployment.created_at),
    updated_at: iso(deployment.updated_at),
  })

  const requireSite = async (repository: RepositorySubject): Promise<SiteRow> => {
    const site = await store.site(repository.id)
    if (!site) throw new ApiError(404, 'Not Found')
    return site
  }

  const siteInput = (body: Record<string, unknown>, current: SiteRow | null): SiteInput => {
    const source = parseSource(body.source, current)
    const buildType = parseBuildType(body.build_type) ?? (source ? 'legacy' : (current?.build_type ?? 'workflow'))
    const branch = source === undefined ? (current?.source_branch ?? null) : (source?.branch ?? null)
    const path = source === undefined ? (current?.source_path ?? '/') : (source?.path ?? '/')
    if (buildType === 'legacy' && !branch) throw new ApiError(422, 'a legacy build needs source.branch')
    return { buildType, sourceBranch: branch, sourcePath: path }
  }

  const checkCname = (body: Record<string, unknown>, repository: RepositorySubject): void => {
    if (body.cname === undefined) return
    const configured = options.hosts ? customDomain(options.hosts, { owner: repository.owner, name: repository.name }) : null
    if ((body.cname ?? null) !== configured) throw new ApiError(422, 'custom domains are declared in the instance configuration (PAGES_DOMAINS)')
  }

  const authorize = async (request: Request, url: URL): Promise<Response> => {
    const redirect = url.searchParams.get('redirect')
    let target: URL
    try {
      target = new URL(redirect ?? '')
    } catch {
      return json(400, { message: 'redirect must be a Pages URL of this instance' })
    }
    if (!isPagesUrl(options.hosts, target)) return json(400, { message: 'redirect must be a Pages URL of this instance' })
    const user = await options.sessionUser(request)
    if (!user) return new Response(null, { status: 302, headers: { Location: `/login?return_to=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 'Cache-Control': 'no-store' } })
    const code = await store.createGrant(user.id, target.host.toLowerCase())
    const callback = new URL(CALLBACK_PATH, target.origin)
    callback.searchParams.set('code', code)
    callback.searchParams.set('path', `${target.pathname}${target.search}`)
    return new Response(null, { status: 302, headers: { Location: callback.toString(), 'Cache-Control': 'no-store' } })
  }

  type Handler = (request: Request, url: URL, params: string[]) => Promise<Response>

  const getSite: Handler = async (request, _url, [owner, name]) => {
    const { repository } = await access(request, owner!, name!, 'read')
    return json(200, await siteJson(options.baseUrl(request), repository, await requireSite(repository)))
  }

  const createSite: Handler = async (request, _url, [owner, name]) => {
    const { principal, repository } = await access(request, owner!, name!, 'admin')
    const body = await readJson(request)
    checkCname(body, repository)
    const site = await store.createSite(repository.id, siteInput(body, null))
    if (!site) throw new ApiError(409, 'GitHub Pages is already enabled.')
    await deployBranch(repository, site, principal)
    return json(201, await siteJson(options.baseUrl(request), repository, site))
  }

  const updateSite: Handler = async (request, _url, [owner, name]) => {
    const { principal, repository } = await access(request, owner!, name!, 'admin')
    const current = await requireSite(repository)
    const body = await readJson(request)
    checkCname(body, repository)
    const site = await store.updateSite(repository.id, siteInput(body, current))
    if (!site) throw new ApiError(404, 'Not Found')
    if (site.source_branch !== current.source_branch || site.source_path !== current.source_path || site.build_type !== current.build_type) await deployBranch(repository, site, principal)
    return empty(204)
  }

  const deleteSite: Handler = async (request, _url, [owner, name]) => {
    const { repository } = await access(request, owner!, name!, 'admin')
    if (!(await store.deleteSite(repository.id))) throw new ApiError(404, 'Not Found')
    return empty(204)
  }

  const listBuilds: Handler = async (request, url, [owner, name]) => {
    const { repository } = await access(request, owner!, name!, 'read')
    await requireSite(repository)
    const { perPage, page, offset } = pagination(url)
    const rows = await store.deployments(repository.id, 'branch', perPage + 1, offset)
    const base = options.baseUrl(request)
    return json(200, rows.slice(0, perPage).map((row) => buildJson(base, repository, row)), linkHeader(url, page, rows.length > perPage))
  }

  const latestBuild: Handler = async (request, _url, [owner, name]) => {
    const { repository } = await access(request, owner!, name!, 'read')
    await requireSite(repository)
    const [latest] = await store.deployments(repository.id, 'branch', 1, 0)
    if (!latest) throw new ApiError(404, 'Not Found')
    return json(200, buildJson(options.baseUrl(request), repository, latest))
  }

  const getBuild: Handler = async (request, _url, [owner, name, id]) => {
    const { repository } = await access(request, owner!, name!, 'read')
    const deployment = await store.deployment(repository.id, Number(id))
    if (!deployment || deployment.source !== 'branch') throw new ApiError(404, 'Not Found')
    return json(200, buildJson(options.baseUrl(request), repository, deployment))
  }

  const requestBuild: Handler = async (request, _url, [owner, name]) => {
    const { principal, repository } = await access(request, owner!, name!, 'write')
    const site = await requireSite(repository)
    if (site.build_type !== 'legacy') throw new ApiError(422, 'this site is deployed by a workflow (build_type workflow)')
    const deployment = await deployBranch(repository, site, principal)
    if (!deployment) throw new ApiError(422, `branch ${site.source_branch} does not exist`)
    const current = (await store.deployment(repository.id, deployment.id)) ?? deployment
    return json(201, { url: apiUrl(options.baseUrl(request), `${repoPath(repository)}/pages/builds/latest`), status: buildStatus(current) })
  }

  const createDeployment: Handler = async (request, url, [owner, name]) => {
    const { principal, repository } = await access(request, owner!, name!, 'write', true)
    await requireSite(repository)
    const base = options.baseUrl(request)
    const type = (request.headers.get('Content-Type') ?? '').split(';', 1)[0]!.trim().toLowerCase()
    if (TAR_TYPES.includes(type)) {
      if (!request.body) throw new ApiError(422, 'request body is empty')
      const version = url.searchParams.get('pages_build_version')
      const deployment = await store.createDeployment(repository.id, { source: 'upload', commitSha: version }, creatorOf(principal))
      const finished = await runDeployment(deploymentContext, repository, deployment, request.body)
      return json(finished.status === 'succeed' ? 200 : 422, deploymentJson(base, repository, finished))
    }
    const body = await readJson(request)
    const artifactId = body.artifact_id === undefined || body.artifact_id === null ? null : String(body.artifact_id)
    const artifactUrl = typeof body.artifact_url === 'string' ? body.artifact_url : null
    if (!artifactId && !artifactUrl) throw new ApiError(422, 'artifact_id or artifact_url is required, or send the site as a tar body')
    if (!options.artifacts) throw new ApiError(422, 'this instance cannot read workflow artifacts yet; send the site as a tar body (Content-Type: application/x-tar)')
    const version = typeof body.pages_build_version === 'string' ? body.pages_build_version : null
    const source: DeploymentSource = 'artifact'
    const deployment = await store.createDeployment(repository.id, { source, commitSha: version, artifactId, artifactUrl }, creatorOf(principal))
    await dispatch(repository, deployment)
    return json(200, deploymentJson(base, repository, (await store.deployment(repository.id, deployment.id)) ?? deployment))
  }

  const getDeployment: Handler = async (request, _url, [owner, name, id]) => {
    const { repository } = await access(request, owner!, name!, 'read', true)
    const deployment = await store.deployment(repository.id, Number(id))
    if (!deployment) throw new ApiError(404, 'Not Found')
    return json(200, deploymentJson(options.baseUrl(request), repository, deployment))
  }

  const cancelDeployment: Handler = async (request, _url, [owner, name, id]) => {
    const { repository } = await access(request, owner!, name!, 'write', true)
    const deployment = await store.deployment(repository.id, Number(id))
    if (!deployment) throw new ApiError(404, 'Not Found')
    await store.cancel(deployment.id)
    return empty(204)
  }

  const REPO = '^/api/v3/repos/([^/]+)/([^/]+)/pages'
  const routes: { readonly pattern: RegExp; readonly methods: Readonly<Record<string, Handler>> }[] = [
    { pattern: new RegExp(`${REPO}$`), methods: { GET: getSite, POST: createSite, PUT: updateSite, DELETE: deleteSite } },
    { pattern: new RegExp(`${REPO}/builds$`), methods: { GET: listBuilds, POST: requestBuild } },
    { pattern: new RegExp(`${REPO}/builds/latest$`), methods: { GET: latestBuild } },
    { pattern: new RegExp(`${REPO}/builds/(\\d+)$`), methods: { GET: getBuild } },
    { pattern: new RegExp(`${REPO}/deployments$`), methods: { POST: createDeployment } },
    { pattern: new RegExp(`${REPO}/deployments/(\\d+)$`), methods: { GET: getDeployment } },
    { pattern: new RegExp(`${REPO}/deployments/(\\d+)/cancel$`), methods: { POST: cancelDeployment } },
  ]

  const api = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (url.pathname === AUTHORIZE_PATH) return request.method === 'GET' ? authorize(request, url) : json(405, { message: 'Method Not Allowed' }, { Allow: 'GET' })
    for (const route of routes) {
      const match = route.pattern.exec(url.pathname)
      if (!match) continue
      const handler = route.methods[request.method]
      if (!handler) return json(405, { message: 'Method Not Allowed' }, { Allow: Object.keys(route.methods).join(', ') })
      try {
        return await handler(request, url, match.slice(1).map(decodeURIComponent))
      } catch (error) {
        if (error instanceof ApiError) return json(error.status, { message: error.message, documentation_url: DOCS }, error.headers)
        throw error
      }
    }
    return null
  }

  return {
    isPagesRequest: (request) => isPagesRequest(options.hosts, request),
    serve: (request) =>
      handlePagesRequest(request, {
        storage,
        store,
        directory: options.directory,
        hosts: options.hosts,
        forgeUrl: options.forgeUrl,
        authenticateToken: options.authenticateToken,
        maxAgeSeconds,
      }),
    api,
    onPush: async (repo, outcome, principal) => {
      const repository = await options.directory.findRepository(repo.owner, repo.name)
      if (!repository) return
      const site = await store.site(repository.id)
      if (!site || site.build_type !== 'legacy' || !site.source_branch) return
      const update = outcome.results.find((result) => result.ok && result.name === `refs/heads/${site.source_branch}` && result.newId !== ZERO_ID)
      if (update) await deployBranch(repository, site, principal, update.newId)
    },
    runJob: async (job) => {
      if (!isPagesJob(job)) return
      const repository = await options.directory.findRepository(job.owner, job.name)
      if (!repository || repository.id !== job.repositoryId) return
      const deployment = await store.deployment(repository.id, job.deployment)
      if (deployment) await runDeployment(deploymentContext, repository, deployment)
    },
    store,
  }
}
