import { atLeast, checkRepositoryAccess, type Database, type Principal, type RepositoryDirectory, type RepositorySubject } from '@git-forge/accounts'
import { type DigestFactory, isLfsOid, isValidName, mediaPath, type PushOutcome, type RepositoryName, type Storage } from '@git-forge/core'
import { ApiError, apiUrl, type EventActor, type ForgeEvent, htmlUrl, json, empty, linkHeader, pagination, readJson, releaseEvent, type ReleaseAction, userObject } from '@git-forge/notifications'
import { AssetUploadError, createTag, defaultBranchOf, isValidTagName, storeAsset, tagExists, TargetError } from './git.ts'
import { buildReleaseNotes, collectReleaseNotes } from './notes.ts'
import { type AssetRow, type Author, createReleaseStore, ReleaseConflictError, type ReleaseInput, type ReleaseRow, type ReleaseStore } from './store.ts'

export type ReleasesOptions = {
  readonly db: Database
  readonly storage: Storage
  readonly directory: RepositoryDirectory
  readonly authenticate: (request: Request) => Promise<Principal | null>
  readonly isInstanceAdmin: (userId: string) => Promise<boolean>
  readonly baseUrl: (request: Request) => string
  readonly maxAssetBytes: number
  readonly digests?: DigestFactory
  readonly now?: () => number
  readonly emit?: (event: ForgeEvent) => Promise<void>
  readonly onTagCreated?: (repo: RepositoryName, outcome: PushOutcome, actor: Principal) => Promise<void>
}

type Context = {
  readonly request: Request
  readonly authenticate: () => Promise<Principal | null>
  readonly url: URL
  readonly options: ReleasesOptions
  readonly store: ReleaseStore
  readonly baseUrl: string
}

type Access = { readonly principal: Principal; readonly repository: RepositorySubject; readonly canWrite: boolean }

const SEGMENT = '([^/]+)'

const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString())

const repoOf = (repository: RepositorySubject): RepositoryName => ({ owner: repository.owner, name: repository.name })

const authorOf = (principal: Principal): Author => {
  switch (principal.kind) {
    case 'user':
      return { kind: 'user', id: principal.id, login: principal.login }
    case 'app':
      return { kind: 'app', id: principal.id, login: `${principal.slug}[bot]` }
    case 'instance':
      return { kind: 'instance', id: principal.issuer, login: null }
    case 'anonymous':
      return { kind: 'anonymous', id: null, login: null }
  }
}

const actorOf = (principal: Principal): EventActor => {
  const author = authorOf(principal)
  return { kind: author.kind === 'anonymous' ? 'system' : (author.kind as EventActor['kind']), id: author.id, login: author.login }
}

const access = async (context: Context, owner: string, name: string, required: 'read' | 'write'): Promise<Access> => {
  if (!isValidName(owner) || !isValidName(name)) throw new ApiError(404, 'Not Found')
  const principal = await context.authenticate()
  if (!principal) throw new ApiError(401, 'Bad credentials', { 'WWW-Authenticate': 'Bearer' })
  const check = await checkRepositoryAccess(context.options.directory, principal, { owner, name }, 'read')
  const instanceAdmin = principal.kind === 'user' && atLeast(principal.limits?.ceiling ?? 'admin', 'write') && (await context.options.isInstanceAdmin(principal.id))
  const repository = check.repository
  if (!repository || (check.decision !== 'allow' && !instanceAdmin)) {
    if (check.decision === 'unauthenticated') throw new ApiError(401, 'Requires authentication', { 'WWW-Authenticate': 'Bearer' })
    throw new ApiError(404, 'Not Found')
  }
  const canWrite = atLeast(check.access, 'write') || instanceAdmin
  if (required === 'write' && !canWrite) {
    if (principal.kind === 'anonymous') throw new ApiError(401, 'Requires authentication', { 'WWW-Authenticate': 'Bearer' })
    throw new ApiError(403, 'Must have push access to repository')
  }
  return { principal, repository, canWrite }
}

const assetJson = (baseUrl: string, repository: RepositorySubject, release: Pick<ReleaseRow, 'tag_name'>, asset: AssetRow) => {
  const path = `${repository.owner}/${repository.name}`
  return {
    url: apiUrl(baseUrl, `/repos/${path}/releases/assets/${asset.id}`),
    browser_download_url: htmlUrl(baseUrl, `/${path}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`),
    media_url: htmlUrl(baseUrl, mediaPath(repoOf(repository), asset.oid, asset.name)),
    id: asset.id,
    node_id: String(asset.id),
    name: asset.name,
    label: asset.label,
    state: 'uploaded',
    content_type: asset.content_type,
    size: asset.size,
    digest: `sha256:${asset.oid}`,
    download_count: asset.download_count,
    created_at: iso(asset.created_at),
    updated_at: iso(asset.updated_at),
    uploader: userObject(baseUrl, asset.uploader_login, asset.uploader_id),
  }
}

export const releaseJson = (baseUrl: string, repository: RepositorySubject, release: ReleaseRow, assets: readonly AssetRow[]) => {
  const path = `${repository.owner}/${repository.name}`
  return {
    url: apiUrl(baseUrl, `/repos/${path}/releases/${release.id}`),
    html_url: htmlUrl(baseUrl, `/${path}/releases/tag/${encodeURIComponent(release.tag_name)}`),
    assets_url: apiUrl(baseUrl, `/repos/${path}/releases/${release.id}/assets`),
    upload_url: `${baseUrl}/api/uploads/repos/${path}/releases/${release.id}/assets{?name,label}`,
    tarball_url: release.draft === 1 ? null : apiUrl(baseUrl, `/repos/${path}/tarball/${encodeURIComponent(release.tag_name)}`),
    zipball_url: release.draft === 1 ? null : apiUrl(baseUrl, `/repos/${path}/zipball/${encodeURIComponent(release.tag_name)}`),
    id: release.id,
    node_id: String(release.id),
    tag_name: release.tag_name,
    target_commitish: release.target_commitish,
    name: release.name,
    body: release.body,
    draft: release.draft === 1,
    prerelease: release.prerelease === 1,
    created_at: iso(release.created_at),
    published_at: iso(release.published_at),
    author: userObject(baseUrl, release.author_login, release.author_id),
    assets: assets.map((asset) => assetJson(baseUrl, repository, release, asset)),
  }
}

const withAssets = async (context: Context, repository: RepositorySubject, release: ReleaseRow) =>
  releaseJson(context.baseUrl, repository, release, await context.store.assets([release.id]))

const optionalText = (body: Record<string, unknown>, key: string): string | null | undefined => {
  const value = body[key]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new ApiError(422, `${key} must be a string`)
  return value
}

const optionalBool = (body: Record<string, unknown>, key: string): boolean | undefined => {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ApiError(422, `${key} must be a boolean`)
  return value
}

const emit = async (context: Context, access: Access, action: ReleaseAction, release: ReleaseRow) => {
  if (!context.options.emit) return
  const payload = await withAssets(context, access.repository, release)
  await context.options.emit(releaseEvent({ baseUrl: context.baseUrl, repository: repoOf(access.repository), actor: actorOf(access.principal) }, action, payload))
}

const ensureTag = async (context: Context, access: Access, input: ReleaseInput): Promise<void> => {
  const repo = repoOf(access.repository)
  if (await tagExists(context.options.storage, repo, input.tagName)) return
  let outcome: PushOutcome | null
  try {
    outcome = await createTag(context.options.storage, repo, input.tagName, input.targetCommitish)
  } catch (error) {
    if (error instanceof TargetError) throw new ApiError(422, error.message)
    throw error
  }
  if (outcome && context.options.onTagCreated) await context.options.onTagCreated(repo, outcome, access.principal)
}

const publishedActions = (release: ReleaseRow): ReleaseAction[] => ['published', release.prerelease === 1 ? 'prereleased' : 'released']

const notesFor = async (context: Context, granted: Access, body: Record<string, unknown>): Promise<{ readonly name: string; readonly body: string }> => {
  const tagName = optionalText(body, 'tag_name')
  if (!tagName || !isValidTagName(tagName)) throw new ApiError(422, 'tag_name is missing or not a valid tag name')
  const repo = repoOf(granted.repository)
  const current = await context.store.byTag(granted.repository.id, tagName)
  const previousTagName =
    optionalText(body, 'previous_tag_name') ??
    (await context.store.list(granted.repository.id, false, 50, 0)).find(
      (release) => release.tag_name !== tagName && release.prerelease === 0 && (current?.published_at == null || (release.published_at ?? 0) < current.published_at),
    )?.tag_name ??
    null
  const range = await collectReleaseNotes(context.options.db, context.options.storage, repo, granted.repository.id, {
    tagName,
    targetCommitish: optionalText(body, 'target_commitish') ?? (await defaultBranchOf(context.options.storage, repo)),
    previousTagName,
    configurationFilePath: optionalText(body, 'configuration_file_path') ?? null,
  })
  if (!range) throw new ApiError(422, 'Validation Failed: target_commitish does not resolve to a commit')
  const path = `/${repo.owner}/${repo.name}`
  return {
    name: tagName,
    body: buildReleaseNotes({
      pulls: range.pulls,
      config: range.config,
      pullUrl: (number) => htmlUrl(context.baseUrl, `${path}/pull/${number}`),
      changelogUrl: htmlUrl(context.baseUrl, previousTagName ? `${path}/compare/${previousTagName}...${tagName}` : `${path}/commits/${tagName}`),
    }),
  }
}

const generateNotes = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'write')
  return json(200, await notesFor(context, granted, await readJson(context.request)))
}

const createWith = async (context: Context, granted: Access, body: Record<string, unknown>): Promise<ReleaseRow> => {
  const tagName = optionalText(body, 'tag_name')
  if (!tagName || !isValidTagName(tagName)) throw new ApiError(422, 'tag_name is missing or not a valid tag name')
  const targetCommitish = optionalText(body, 'target_commitish') ?? (await defaultBranchOf(context.options.storage, repoOf(granted.repository)))
  const generated = optionalBool(body, 'generate_release_notes') ? await notesFor(context, granted, { ...body, target_commitish: targetCommitish }) : null
  const text = optionalText(body, 'body') ?? null
  const input: ReleaseInput = {
    tagName,
    targetCommitish,
    name: optionalText(body, 'name') || generated?.name || null,
    body: generated ? (text ? `${text}\n\n${generated.body}` : generated.body) : text,
    draft: optionalBool(body, 'draft') ?? false,
    prerelease: optionalBool(body, 'prerelease') ?? false,
  }
  if (await context.store.byTag(granted.repository.id, tagName)) throw new ApiError(422, `Validation Failed: a release for tag ${tagName} already exists`)
  if (!input.draft) await ensureTag(context, granted, input)
  let release: ReleaseRow
  try {
    release = await context.store.create(granted.repository.id, input, authorOf(granted.principal))
  } catch (error) {
    if (error instanceof ReleaseConflictError) throw new ApiError(422, `Validation Failed: ${error.message}`)
    throw error
  }
  await emit(context, granted, 'created', release)
  if (!input.draft) for (const action of publishedActions(release)) await emit(context, granted, action, release)
  return release
}

const createRelease = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'write')
  const release = await createWith(context, granted, await readJson(context.request))
  return json(201, await withAssets(context, granted.repository, release), { Location: apiUrl(context.baseUrl, `/repos/${granted.repository.owner}/${granted.repository.name}/releases/${release.id}`) })
}

const listReleases = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'read')
  const { perPage, page, offset } = pagination(context.url)
  const rows = await context.store.list(granted.repository.id, granted.canWrite, perPage + 1, offset)
  const releases = rows.slice(0, perPage)
  const assets = await context.store.assets(releases.map((release) => release.id))
  return json(
    200,
    releases.map((release) => releaseJson(context.baseUrl, granted.repository, release, assets.filter((asset) => asset.release_id === release.id))),
    linkHeader(context.url, page, rows.length > perPage),
  )
}

const visibleRelease = (granted: Access, release: ReleaseRow | null): ReleaseRow => {
  if (!release || (release.draft === 1 && !granted.canWrite)) throw new ApiError(404, 'Not Found')
  return release
}

const releaseById = async (context: Context, granted: Access, id: string | undefined): Promise<ReleaseRow> => {
  const number = Number(id)
  return visibleRelease(granted, Number.isSafeInteger(number) ? await context.store.get(granted.repository.id, number) : null)
}

const getRelease = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'read')
  return json(200, await withAssets(context, granted.repository, await releaseById(context, granted, params[2])))
}

const latestRelease = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'read')
  const release = await context.store.latest(granted.repository.id)
  if (!release) throw new ApiError(404, 'Not Found')
  return json(200, await withAssets(context, granted.repository, release))
}

const releaseByTag = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'read')
  const release = visibleRelease(granted, await context.store.byTag(granted.repository.id, params[2]!))
  return json(200, await withAssets(context, granted.repository, release))
}

const updateWith = async (context: Context, granted: Access, release: ReleaseRow, body: Record<string, unknown>): Promise<ReleaseRow> => {
  const tagName = optionalText(body, 'tag_name') ?? release.tag_name
  if (!isValidTagName(tagName)) throw new ApiError(422, 'tag_name is not a valid tag name')
  const input: ReleaseInput = {
    tagName,
    targetCommitish: optionalText(body, 'target_commitish') ?? release.target_commitish,
    name: optionalText(body, 'name') === undefined ? release.name : (optionalText(body, 'name') ?? null),
    body: optionalText(body, 'body') === undefined ? release.body : (optionalText(body, 'body') ?? null),
    draft: optionalBool(body, 'draft') ?? release.draft === 1,
    prerelease: optionalBool(body, 'prerelease') ?? release.prerelease === 1,
  }
  if (!input.draft) await ensureTag(context, granted, input)
  let updated: ReleaseRow
  try {
    updated = await context.store.update(release, input)
  } catch (error) {
    if (error instanceof ReleaseConflictError) throw new ApiError(422, `Validation Failed: ${error.message}`)
    throw error
  }
  const published = release.draft === 1 && updated.draft === 0
  const unpublished = release.draft === 0 && updated.draft === 1
  if (published) for (const action of publishedActions(updated)) await emit(context, granted, action, updated)
  else await emit(context, granted, unpublished ? 'unpublished' : 'edited', updated)
  return updated
}

const updateRelease = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'write')
  const updated = await updateWith(context, granted, await releaseById(context, granted, params[2]), await readJson(context.request))
  return json(200, await withAssets(context, granted.repository, updated))
}

const deleteWith = async (context: Context, granted: Access, release: ReleaseRow): Promise<void> => {
  await context.store.delete(release.id)
  await emit(context, granted, 'deleted', release)
}

const deleteRelease = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'write')
  await deleteWith(context, granted, await releaseById(context, granted, params[2]))
  return empty(204)
}

const listAssets = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'read')
  const release = await releaseById(context, granted, params[2])
  return json(
    200,
    (await context.store.assets([release.id])).map((asset) => assetJson(context.baseUrl, granted.repository, release, asset)),
  )
}

const ASSET_NAME_REPLACEMENT = /[^A-Za-z0-9._+@~-]+/g

export const normalizeAssetName = (name: string): string =>
  name.trim().replace(ASSET_NAME_REPLACEMENT, '.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 255)

const uploadAsset = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'write')
  const release = await releaseById(context, granted, params[2])
  const rawName = context.url.searchParams.get('name')
  const name = rawName ? normalizeAssetName(rawName) : ''
  if (!name) throw new ApiError(422, 'name is required')
  const label = context.url.searchParams.get('label')
  const length = context.request.headers.get('Content-Length')
  const size = length === null ? NaN : Number(length)
  if (!Number.isSafeInteger(size) || size < 0) throw new ApiError(411, 'Content-Length is required')
  if (size > context.options.maxAssetBytes) throw new ApiError(413, `asset exceeds ${context.options.maxAssetBytes} bytes`)
  if (await context.store.assetByName(release.id, name)) throw new ApiError(422, `Validation Failed: an asset named ${name} already exists`)
  const sha256 = context.request.headers.get('X-Content-SHA256')?.trim().toLowerCase()
  if (sha256 !== undefined && !isLfsOid(sha256)) throw new ApiError(422, 'X-Content-SHA256 must be 64 hex digits')
  let stored
  try {
    stored = await storeAsset(context.options.storage, repoOf(granted.repository), context.request.body ?? new Blob([]).stream(), size, {
      ...(sha256 ? { sha256 } : {}),
      ...(context.options.digests ? { digests: context.options.digests } : {}),
    })
  } catch (error) {
    if (error instanceof AssetUploadError) throw new ApiError(error.status, error.message)
    if (error instanceof TypeError || /length|size/i.test((error as Error).message)) throw new ApiError(400, `upload failed: ${(error as Error).message}`)
    throw error
  }
  const contentType = context.request.headers.get('Content-Type')?.split(';')[0]?.trim() || 'application/octet-stream'
  try {
    const asset = await context.store.addAsset(release.id, { name, label, contentType, size: stored.size, oid: stored.oid }, authorOf(granted.principal))
    return json(201, assetJson(context.baseUrl, granted.repository, release, asset))
  } catch (error) {
    if (error instanceof ReleaseConflictError) throw new ApiError(422, `Validation Failed: ${error.message}`)
    throw error
  }
}

const assetOf = async (context: Context, granted: Access, id: string | undefined) => {
  const number = Number(id)
  const asset = Number.isSafeInteger(number) ? await context.store.asset(granted.repository.id, number) : null
  if (!asset || (asset.draft === 1 && !granted.canWrite)) throw new ApiError(404, 'Not Found')
  return asset
}

const redirectToMedia = (granted: Access, asset: AssetRow): Response =>
  new Response(null, {
    status: 302,
    headers: {
      Location: mediaPath(repoOf(granted.repository), asset.oid, asset.name),
      'Cache-Control': granted.repository.visibility === 'public' ? 'public, max-age=60' : 'private, no-store',
    },
  })

const getAsset = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'read')
  const asset = await assetOf(context, granted, params[2])
  if ((context.request.headers.get('Accept') ?? '').includes('application/octet-stream')) {
    await context.store.countDownload(asset.id)
    return redirectToMedia(granted, asset)
  }
  return json(200, assetJson(context.baseUrl, granted.repository, asset, asset))
}

const updateAsset = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'write')
  const asset = await assetOf(context, granted, params[2])
  const body = await readJson(context.request)
  const requested = optionalText(body, 'name')
  const name = requested ? normalizeAssetName(requested) : asset.name
  if (!name) throw new ApiError(422, 'name must not be empty')
  const label = optionalText(body, 'label') === undefined ? asset.label : (optionalText(body, 'label') ?? null)
  try {
    await context.store.updateAsset(asset.id, name, label)
  } catch (error) {
    if (error instanceof ReleaseConflictError) throw new ApiError(422, `Validation Failed: ${error.message}`)
    throw error
  }
  return json(200, assetJson(context.baseUrl, granted.repository, asset, { ...asset, name, label }))
}

const deleteAsset = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'write')
  const asset = await assetOf(context, granted, params[2])
  await context.store.deleteAsset(asset.id)
  return empty(204)
}

export const releaseOperations = (options: ReleasesOptions, principal: Principal, baseUrl: string) => {
  const granted = async (owner: string, name: string) => {
    const context: Context = {
      request: new Request(baseUrl),
      authenticate: async () => principal,
      url: new URL(baseUrl),
      options,
      store: createReleaseStore(options.db, options.now),
      baseUrl,
    }
    return { context, access: await access(context, owner, name, 'write') }
  }
  const byId = async (owner: string, name: string, id: number) => {
    const { context, access: writer } = await granted(owner, name)
    return { context, writer, release: await releaseById(context, writer, String(id)) }
  }
  return {
    create: async (owner: string, name: string, body: Record<string, unknown>): Promise<ReleaseRow> => {
      const { context, access: writer } = await granted(owner, name)
      return createWith(context, writer, body)
    },
    update: async (owner: string, name: string, id: number, body: Record<string, unknown>): Promise<ReleaseRow> => {
      const { context, writer, release } = await byId(owner, name, id)
      return updateWith(context, writer, release, body)
    },
    remove: async (owner: string, name: string, id: number): Promise<void> => {
      const { context, writer, release } = await byId(owner, name, id)
      await deleteWith(context, writer, release)
    },
    generateNotes: async (owner: string, name: string, body: Record<string, unknown>) => {
      const { context, access: writer } = await granted(owner, name)
      return notesFor(context, writer, body)
    },
  }
}

export type ReleaseOperations = ReturnType<typeof releaseOperations>

const download = async (context: Context, params: string[]): Promise<Response> => {
  const granted = await access(context, params[0]!, params[1]!, 'read')
  const release = visibleRelease(granted, await context.store.byTag(granted.repository.id, params[2]!))
  const asset = await context.store.assetByName(release.id, params[3]!)
  if (!asset) throw new ApiError(404, 'Not Found')
  if (context.request.method === 'GET') await context.store.countDownload(asset.id)
  return redirectToMedia(granted, asset)
}

type Handler = (context: Context, params: string[]) => Promise<Response>

const API = `^/api/v3/repos/${SEGMENT}/${SEGMENT}/releases`

const ROUTES: { readonly pattern: RegExp; readonly methods: Readonly<Record<string, Handler>> }[] = [
  { pattern: new RegExp(`${API}$`), methods: { GET: listReleases, POST: createRelease } },
  { pattern: new RegExp(`${API}/latest$`), methods: { GET: latestRelease } },
  { pattern: new RegExp(`${API}/generate-notes$`), methods: { POST: generateNotes } },
  { pattern: new RegExp(`${API}/tags/(.+)$`), methods: { GET: releaseByTag } },
  { pattern: new RegExp(`${API}/assets/(\\d+)$`), methods: { GET: getAsset, PATCH: updateAsset, DELETE: deleteAsset } },
  { pattern: new RegExp(`${API}/(\\d+)$`), methods: { GET: getRelease, PATCH: updateRelease, DELETE: deleteRelease } },
  { pattern: new RegExp(`${API}/(\\d+)/assets$`), methods: { GET: listAssets, POST: uploadAsset } },
  { pattern: new RegExp(`^/api/uploads/repos/${SEGMENT}/${SEGMENT}/releases/(\\d+)/assets$`), methods: { POST: uploadAsset } },
  { pattern: new RegExp(`^/${SEGMENT}/${SEGMENT}/releases/download/(.+)/([^/]+)$`), methods: { GET: download, HEAD: download } },
]

export const handleReleasesRequest = async (request: Request, options: ReleasesOptions): Promise<Response | null> => {
  const url = new URL(request.url)
  for (const route of ROUTES) {
    const match = route.pattern.exec(url.pathname)
    if (!match) continue
    const handler = route.methods[request.method]
    if (!handler) return json(405, { message: 'Method Not Allowed' }, { Allow: Object.keys(route.methods).join(', ') })
    const context: Context = { request, authenticate: () => options.authenticate(request), url, options, store: createReleaseStore(options.db, options.now), baseUrl: options.baseUrl(request) }
    try {
      return await handler(context, match.slice(1).map(decodeURIComponent))
    } catch (error) {
      if (error instanceof ApiError) return json(error.status, { message: error.message, documentation_url: 'https://docs.github.com/rest/releases' }, error.headers)
      throw error
    }
  }
  return null
}
