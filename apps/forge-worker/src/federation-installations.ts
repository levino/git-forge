import {
  type AccountsStore,
  type AuthorizeRequest,
  authorizeUrl,
  CALLBACK_PATH,
  checkRepositoryAccess,
  EXCHANGE_PATH,
  type FederationConnection,
  type FederationInstallation,
  type FederationInstallationStore,
  INSTALLATION_PATH,
  type InstancePrincipal,
  type JwksSource,
  mintExchangeToken,
  mintInstallationToken,
  normalizeIssuer,
  parseAuthorizeRequest,
  type Principal,
  type RepositorySelection,
  type SigningKey,
  type UserPrincipal,
  verifyExchangeToken,
} from '@git-forge/accounts'
import { type FetchFunction, type MirrorConfig, outboundUrlError, readAll } from '@git-forge/core'

export class FederationFlowError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const fail = (status: number, message: string): never => {
  throw new FederationFlowError(status, message)
}

type Account = { readonly id: string; readonly login: string }

export type Consent = { readonly account: string; readonly selection: string; readonly repositoryIds: readonly string[] }

export type RemoteInstallation = {
  readonly id: string
  readonly account: string
  readonly selection: RepositorySelection
  readonly scopes: readonly string[]
  readonly repositories: readonly { readonly name: string; readonly visibility: string }[]
}

export type FederationInstallationsOptions = {
  readonly store: AccountsStore
  readonly installations: FederationInstallationStore
  readonly publicUrl: string | undefined
  readonly instanceKey: SigningKey | undefined
  readonly issuerFor: (request: Request) => string
  readonly openJwks: JwksSource
  readonly fetch: FetchFunction
  readonly allowPrivateHosts: boolean
  readonly managedAccounts: (user: UserPrincipal) => Promise<readonly Account[]>
  readonly principal: (request: Request) => Promise<Principal | null>
  readonly verifyToken: (request: Request, token: string) => Promise<InstancePrincipal | null>
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })

const bearer = (request: Request): string | null => /^\s*Bearer\s+(\S+)\s*$/i.exec(request.headers.get('Authorization') ?? '')?.[1] ?? null

const parseObject = (text: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {}
  return fail(400, 'expected a JSON object')
}

const readObject = async (body: ReadableStream<Uint8Array> | null): Promise<Record<string, unknown>> => {
  if (!body) return {}
  let bytes: Uint8Array
  try {
    bytes = await readAll(body, 64 * 1024)
  } catch {
    return fail(413, 'request body too large')
  }
  return parseObject(new TextDecoder().decode(bytes))
}

const text = (body: Record<string, unknown>, key: string): string => (typeof body[key] === 'string' ? (body[key] as string) : fail(400, `${key} is required`))

export const installationJson = (installation: FederationInstallation) => ({
  id: installation.id,
  issuer: installation.issuer,
  subject: installation.subject,
  account: installation.accountLogin,
  selection: installation.selection,
  scopes: installation.scopes,
  grantedBy: installation.grantedByLogin,
  createdAt: new Date(installation.createdAt).toISOString(),
  revokedAt: installation.revokedAt === null ? null : new Date(installation.revokedAt).toISOString(),
})

const connectionJson = (connection: FederationConnection) => ({ upstream: connection.upstream, installation: connection.installation, createdAt: new Date(connection.createdAt).toISOString() })

export const createFederationInstallations = (options: FederationInstallationsOptions) => {
  const { store, installations } = options
  const policy = { allowPrivateHosts: options.allowPrivateHosts }

  const signer = (): { readonly issuer: string; readonly key: SigningKey } =>
    options.publicUrl && options.instanceKey ? { issuer: options.publicUrl, key: options.instanceKey } : fail(503, 'federation needs PUBLIC_URL and INSTANCE_KEY')

  const authorizeRequest = (params: { readonly get: (name: string) => string | null }): AuthorizeRequest => {
    let request: AuthorizeRequest
    try {
      request = parseAuthorizeRequest(params)
    } catch (error) {
      return fail(400, (error as Error).message)
    }
    const blocked = outboundUrlError(request.issuer, policy)
    return blocked ? fail(400, blocked) : request
  }

  const consent = async (user: UserPrincipal, request: AuthorizeRequest, choice: Consent): Promise<string> => {
    const account = (await options.managedAccounts(user)).find((candidate) => candidate.login.toLowerCase() === choice.account.toLowerCase()) ?? fail(403, `you do not manage ${choice.account}`)
    if (choice.selection !== 'all' && choice.selection !== 'selected') fail(400, 'selection must be all or selected')
    const repositoryIds = choice.selection === 'selected' ? [...new Set(choice.repositoryIds)] : []
    if (choice.selection === 'selected' && repositoryIds.length === 0) fail(400, 'choose at least one repository')
    for (const id of repositoryIds) if ((await store.findRepositoryById(id))?.ownerId !== account.id) fail(422, `repository ${id} does not belong to ${account.login}`)
    const { code } = await installations.install({ request, accountId: account.id, selection: choice.selection as RepositorySelection, repositoryIds, grantedBy: user.id })
    const target = new URL(request.redirectUri)
    target.searchParams.set('code', code)
    target.searchParams.set('state', request.state)
    return target.toString()
  }

  const installed = async (user: UserPrincipal, accountLogin?: string): Promise<FederationInstallation[]> => {
    const accounts = (await options.managedAccounts(user)).filter((account) => accountLogin === undefined || account.login.toLowerCase() === accountLogin.toLowerCase())
    if (accountLogin !== undefined && accounts.length === 0) fail(404, 'organization not found')
    return installations.installationsOn(accounts.map((account) => account.id))
  }

  const revoke = async (user: UserPrincipal, id: string): Promise<void> => {
    const installation = await installations.installation(id)
    const allowed =
      installation !== null &&
      installation.revokedAt === null &&
      (installation.grantedBy === user.id || (await options.managedAccounts(user)).some((account) => account.id === installation.accountId) || (await store.isInstanceAdmin(user.id)))
    if (!allowed) fail(404, 'installation not found')
    await installations.revoke(id, { kind: 'user', id: user.id })
  }

  const start = async (user: UserPrincipal, sessionId: string | null, input: string): Promise<string> => {
    const { issuer } = signer()
    let upstream: string
    try {
      upstream = normalizeIssuer(input.trim())
    } catch {
      return fail(400, `invalid forge URL ${input}`)
    }
    const blocked = outboundUrlError(upstream, policy)
    if (blocked) fail(400, blocked)
    if (upstream === normalizeIssuer(issuer)) fail(400, 'that is this forge')
    const { state, challenge } = await installations.startRequest({ userId: user.id, sessionId, upstream })
    return authorizeUrl(upstream, { issuer, redirectUri: `${issuer}${CALLBACK_PATH}`, state, challenge, subject: user.id, login: user.login })
  }

  const send = async (request: Request): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> => {
    let response: Response
    try {
      response = await options.fetch(request)
    } catch (error) {
      return fail(502, `${new URL(request.url).origin} is unreachable: ${(error as Error).message}`)
    }
    try {
      return { status: response.status, body: await readObject(response.body) }
    } catch {
      return { status: response.status, body: {} }
    }
  }

  const complete = async (user: UserPrincipal, sessionId: string | null, state: string, code: string): Promise<FederationConnection> => {
    const { issuer, key } = signer()
    const pending = (await installations.takeRequest(state, user.id, sessionId)) ?? fail(400, 'this authorization expired or was started by another session; start again')
    const token = await mintExchangeToken({ key, issuer, audience: pending.upstream, subject: user.id })
    const { status, body } = await send(
      new Request(`${pending.upstream}${EXCHANGE_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: pending.verifier, redirect_uri: `${issuer}${CALLBACK_PATH}` }),
      }),
    )
    if (status !== 200 || typeof body.id !== 'string') fail(502, `${pending.upstream} refused the code: ${String(body.error ?? status)}`)
    try {
      return await installations.connect({ upstream: pending.upstream, installation: body.id as string, userId: user.id })
    } catch (error) {
      return fail(409, (error as Error).message)
    }
  }

  const remoteInstallation = async (connection: FederationConnection): Promise<RemoteInstallation | null> => {
    const { issuer, key } = signer()
    const token = await mintInstallationToken({ key, issuer, audience: connection.upstream, subject: connection.userId, installation: connection.installation, repositories: [] })
    const { status, body } = await send(new Request(`${connection.upstream}${INSTALLATION_PATH}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }))
    if (status === 401 || status === 403 || status === 404) return null
    if (status !== 200) fail(502, `${connection.upstream} answered ${status}`)
    return body as RemoteInstallation
  }

  const connectionOf = async (user: UserPrincipal, installation: string): Promise<FederationConnection> =>
    (await installations.connectionsOf(user.id)).find((connection) => connection.installation === installation) ?? fail(404, 'installation not found')

  const status = async (config: MirrorConfig): Promise<'active' | 'revoked' | 'unreachable' | null> => {
    if (config.auth !== 'installation' || !config.installation) return null
    const connection = await installations.connection(normalizeIssuer(new URL(config.url).origin), config.installation)
    if (!connection) return 'revoked'
    try {
      return (await remoteInstallation(connection)) ? 'active' : 'revoked'
    } catch {
      return 'unreachable'
    }
  }

  const describe = async (request: Request): Promise<Response> => {
    const token = bearer(request)
    const principal = token ? await options.verifyToken(request, token) : null
    if (!principal?.installation) return json(401, { error: 'an installation token is required' })
    const installation = (await installations.installation(principal.installation.id))!
    const candidates = await installations.candidates(installation)
    const reader = { ...principal, repositories: candidates.map((candidate) => `${candidate.owner}/${candidate.name}`.toLowerCase()) }
    const repositories: { name: string; visibility: string }[] = []
    for (const candidate of candidates) {
      const check = await checkRepositoryAccess(store, reader, candidate, 'read')
      if (check.decision === 'allow' && check.repository) repositories.push({ name: `${candidate.owner}/${candidate.name}`, visibility: check.repository.visibility })
    }
    return json(200, { id: installation.id, account: installation.accountLogin, selection: installation.selection, scopes: principal.scopes, repositories })
  }

  const exchange = async (request: Request): Promise<Response> => {
    const token = bearer(request) ?? fail(401, 'a signed client token is required')
    const body = await readObject(request.body)
    const code = text(body, 'code')
    const installation = (await installations.codeInstallation(code)) ?? fail(400, 'invalid_grant')
    if (!(await verifyExchangeToken(token, { audience: options.issuerFor(request), jwks: options.openJwks, issuer: installation.issuer, subject: installation.subject }))) fail(401, 'invalid client token')
    if (!(await installations.redeemCode(code, text(body, 'redirect_uri'), text(body, 'code_verifier')))) fail(400, 'invalid_grant')
    return json(200, installationJson(installation))
  }

  const requireUser = async (request: Request): Promise<UserPrincipal> => {
    const principal = await options.principal(request)
    if (!principal || principal.kind === 'anonymous') return fail(401, 'authentication required')
    if (principal.kind !== 'user' || (principal.limits !== null && principal.limits.ceiling !== 'admin')) return fail(403, 'this needs a session or a full-access token')
    return principal
  }

  const routes: readonly [string, RegExp, (request: Request, params: string[]) => Promise<Response>][] = [
    ['POST', new RegExp(`^${EXCHANGE_PATH}$`), exchange],
    ['GET', new RegExp(`^${INSTALLATION_PATH}$`), describe],
    [
      'POST',
      /^\/api\/federation\/authorize$/,
      async (request) => {
        const user = await requireUser(request)
        const body = await readObject(request.body)
        const params = { get: (name: string) => (typeof body[name] === 'string' ? (body[name] as string) : null) }
        const repositories = Array.isArray(body.repositories) ? body.repositories.filter((item): item is string => typeof item === 'string') : []
        const account = text(body, 'account')
        const ids = await Promise.all(repositories.map(async (name) => (await store.findRepository(account, name))?.id ?? fail(422, `repository ${account}/${name} not found`)))
        return json(200, { redirect: await consent(user, authorizeRequest(params), { account, selection: typeof body.selection === 'string' ? body.selection : 'all', repositoryIds: ids }) })
      },
    ],
    ['GET', /^\/api\/user\/federation\/installations$/, async (request) => json(200, (await installed(await requireUser(request))).map(installationJson))],
    ['GET', /^\/api\/orgs\/([^/]+)\/federation\/installations$/, async (request, [org]) => json(200, (await installed(await requireUser(request), org!)).map(installationJson))],
    [
      'DELETE',
      /^\/api\/federation\/installations\/([^/]+)$/,
      async (request, [id]) => {
        await revoke(await requireUser(request), id!)
        return new Response(null, { status: 204 })
      },
    ],
    ['GET', /^\/api\/federation\/connections$/, async (request) => json(200, (await installations.connectionsOf((await requireUser(request)).id)).map(connectionJson))],
    [
      'POST',
      /^\/api\/federation\/connections$/,
      async (request) => {
        const user = await requireUser(request)
        return json(201, { authorizeUrl: await start(user, null, text(await readObject(request.body), 'upstream')) })
      },
    ],
    [
      'POST',
      /^\/api\/federation\/connections\/complete$/,
      async (request) => {
        const user = await requireUser(request)
        const body = await readObject(request.body)
        return json(201, connectionJson(await complete(user, null, text(body, 'state'), text(body, 'code'))))
      },
    ],
    [
      'GET',
      /^\/api\/federation\/connections\/([^/]+)$/,
      async (request, [id]) => {
        const connection = await connectionOf(await requireUser(request), id!)
        const remote = await remoteInstallation(connection)
        return json(200, { ...connectionJson(connection), active: remote !== null, ...(remote ? { account: remote.account, selection: remote.selection, repositories: remote.repositories } : {}) })
      },
    ],
  ]

  const handle = async (request: Request): Promise<Response | null> => {
    const { pathname } = new URL(request.url)
    const match = routes.find(([method, pattern]) => method === request.method && pattern.test(pathname))
    if (!match) return null
    try {
      return await match[2](request, match[1].exec(pathname)!.slice(1).map(decodeURIComponent))
    } catch (error) {
      if (error instanceof FederationFlowError) return json(error.status, { error: error.message })
      throw error
    }
  }

  return {
    handle,
    ui: {
      authorizeRequest,
      consent,
      installed,
      revoke,
      start,
      complete,
      connections: (user: UserPrincipal) => installations.connectionsOf(user.id),
      remote: async (user: UserPrincipal, installation: string) => {
        const connection = await connectionOf(user, installation)
        return { connection, remote: await remoteInstallation(connection) }
      },
      status,
      managedAccounts: options.managedAccounts,
    },
  }
}

export type FederationInstallations = ReturnType<typeof createFederationInstallations>
