import {
  type AgentConnection,
  type AgentStore,
  AUTHORIZATION_SERVER_PATH,
  clampAgentToken,
  MCP_PATH,
  mcpResource,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
  type OAuthClient,
  parseAgentScope,
  parseClientRegistration,
  PROTECTED_RESOURCE_PATH,
  type RedirectTarget,
  redirectMatches,
  parseRedirectUri,
  resolveResource,
} from './agents.ts'
import { parseAuthorization } from './authorize.ts'
import { cleanClientText, isClientState, isPkceChallenge, loopbackRedirect } from './cli-login.ts'
import { LoginError } from './login.ts'
import { checkSession, LOGIN_RATE_LIMITS, type LoginHttpOptions, readForm, readJson, readParams } from './login-http.ts'
import { type LoginPage, renderLoginPage } from './login-pages.ts'
import { handleMcpRequest, JSONRPC, type McpServer, toolError, toolResult } from './mcp.ts'
import type { RepositorySubject, UserPrincipal } from './permissions.ts'
import type { RateLimit } from './rate-limit.ts'
import { grantedScope, isTokenScope, TOKEN_SCOPES, type TokenScope } from './tokens.ts'

export type AgentHttpOptions = {
  readonly login: LoginHttpOptions
  readonly agents: AgentStore
  readonly version: string
  readonly canRead: (user: UserPrincipal, repository: RepositorySubject) => Promise<boolean>
}

export const AGENT_TOOL_RATE_LIMIT: RateLimit = { name: 'agent-token', limit: 120, windowMs: 10 * 60 * 1000 }

const MAX_REPOSITORIES = 50

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version' }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers } })

const oauthError = (status: number, error: string, description?: string) => json(status, { error, ...(description ? { error_description: description } : {}) })

const seeOther = (location: string) => new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } })

type AuthorizationRequest = {
  readonly client: OAuthClient
  readonly redirect: RedirectTarget
  readonly state: string | null
  readonly codeChallenge: string
  readonly scope: TokenScope
  readonly resource: string
}

type ParsedAuthorization = { readonly kind: 'ok'; readonly request: AuthorizationRequest } | { readonly kind: 'page'; readonly message: string } | { readonly kind: 'redirect'; readonly location: string }

type McpContext = { readonly connection: AgentConnection }

const user = (connection: AgentConnection): UserPrincipal => ({ kind: 'user', id: connection.userId, login: connection.login, limits: null, tokenId: null })

export const createAgentHandler = (options: AgentHttpOptions) => {
  const { context } = options.login
  const { agents } = options
  const { store } = context
  const origin = context.origin
  const resource = mcpResource(origin)
  const metadataUrl = `${origin}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`
  const clientAddress = (request: Request) => options.login.clientAddress?.(request) ?? null

  const page = async (request: Request, model: LoginPage): Promise<Response> => (await options.login.renderPage?.(model, request)) ?? renderLoginPage(model)

  const limited = async (request: Request, limit: RateLimit): Promise<Response | null> => {
    const decision = await context.logins.hitRateLimit(limit, `ip:${clientAddress(request) ?? 'unknown'}`)
    return decision.allowed ? null : oauthError(429, 'rate_limited', `try again in ${decision.retryAfterSeconds} seconds`)
  }

  const resourceMetadata = (path: string) =>
    json(200, { resource: path === PROTECTED_RESOURCE_PATH ? origin : resource, authorization_servers: [origin], bearer_methods_supported: ['header'], resource_name: `git-forge on ${new URL(origin).host}` })

  const serverMetadata = () =>
    json(200, {
      issuer: origin,
      authorization_endpoint: `${origin}${OAUTH_AUTHORIZE_PATH}`,
      token_endpoint: `${origin}${OAUTH_TOKEN_PATH}`,
      registration_endpoint: `${origin}${OAUTH_REGISTER_PATH}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: TOKEN_SCOPES,
      authorization_response_iss_parameter_supported: true,
    })

  const register = async (request: Request): Promise<Response> => {
    const body = await readJson(request).catch(() => null)
    if (!body) return oauthError(400, 'invalid_client_metadata', 'expected a JSON object')
    const parsed = parseClientRegistration(body)
    if ('error' in parsed) return oauthError(400, parsed.error, parsed.description)
    const client = await agents.registerClient(parsed, clientAddress(request))
    return json(201, {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.name,
      ...(client.uri ? { client_uri: client.uri } : {}),
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
  }

  const parseRequest = async (params: URLSearchParams): Promise<ParsedAuthorization> => {
    const client = await agents.findClient(params.get('client_id'))
    if (!client) return { kind: 'page', message: 'This agent is not registered here. Remove the server from your agent and add it again.' }
    const presented = params.get('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null)
    const redirect = presented !== null && redirectMatches(client.redirectUris, presented) ? parseRedirectUri(presented) : null
    if (!redirect) return { kind: 'page', message: 'The agent asked to return to an address it did not register.' }
    const rawState = params.get('state')
    const state = isClientState(rawState) ? rawState : null
    const fail = (error: string, description: string): ParsedAuthorization => ({
      kind: 'redirect',
      location: loopbackRedirect(redirect.uri, { error, error_description: description, ...(state ? { state } : {}), iss: origin }),
    })
    if (rawState !== null && state === null) return fail('invalid_request', 'state is malformed')
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported')
    const codeChallenge = params.get('code_challenge')
    if (params.get('code_challenge_method') !== 'S256' || !isPkceChallenge(codeChallenge)) return fail('invalid_request', 'a PKCE code_challenge with method S256 is required')
    const scope = parseAgentScope(params.get('scope'))
    if (!scope) return fail('invalid_scope', 'scope must be repo:read, repo:write or repo:admin')
    const target = resolveResource(origin, params.get('resource'))
    if (!target) return fail('invalid_target', `resource must be ${resource}`)
    return { kind: 'ok', request: { client, redirect, state, codeChallenge, scope, resource: target } }
  }

  const consent = async (request: Request, url: URL, parsed: AuthorizationRequest, query: string, login: string, csrf: string, message?: string) =>
    page(request, {
      kind: 'agent',
      consent: { clientName: parsed.client.name, clientUri: parsed.client.uri, redirectHost: parsed.redirect.host, formAction: parsed.redirect.formAction, scope: parsed.scope, request: query },
      user: { login, csrf },
      instance: url.host,
      ...(message ? { message } : {}),
    })

  const authorizePage = async (request: Request, url: URL): Promise<Response> => {
    const parsed = await parseRequest(url.searchParams)
    if (parsed.kind === 'page') return page(request, { kind: 'error', status: 400, message: parsed.message })
    if (parsed.kind === 'redirect') return seeOther(parsed.location)
    const check = await checkSession(request, options.login)
    if (check.kind !== 'session') return seeOther(`/login?return_to=${encodeURIComponent(`${url.pathname}${url.search}`)}`)
    return consent(request, url, parsed.request, url.searchParams.toString(), check.active.session.login, check.active.csrf)
  }

  const resolveRepositories = async (principal: UserPrincipal, names: readonly string[]): Promise<{ ids: string[] } | { missing: string }> => {
    const ids: string[] = []
    for (const name of names) {
      const [owner, repo, ...rest] = name.split('/')
      const found = owner && repo && rest.length === 0 ? await store.findRepository(owner, repo.replace(/\.git$/, '')) : null
      if (!found || !(await options.canRead(principal, found))) return { missing: name }
      ids.push(found.id)
    }
    return { ids: [...new Set(ids)] }
  }

  const decide = async (request: Request, url: URL): Promise<Response> => {
    const check = await checkSession(request, options.login)
    if (check.kind !== 'session') return page(request, { kind: 'error', status: 403, message: 'Your session expired or the form is stale. Start the connection in your agent again.' })
    const form = await readForm(request)
    const query = form.get('request') ?? ''
    const parsed = await parseRequest(new URLSearchParams(query))
    if (parsed.kind === 'page') return page(request, { kind: 'error', status: 400, message: parsed.message })
    if (parsed.kind === 'redirect') return seeOther(parsed.location)
    const authorization = parsed.request
    const back = (params: Record<string, string>) => seeOther(loopbackRedirect(authorization.redirect.uri, { ...params, ...(authorization.state ? { state: authorization.state } : {}), iss: origin }))
    if (form.get('decision') !== 'approve') return back({ error: 'access_denied', error_description: 'the user denied the request' })
    const { session, csrf } = check.active
    const names = (form.get('repositories') ?? '').split(/[\s,]+/).filter((name) => name !== '')
    if (names.length > MAX_REPOSITORIES) return consent(request, url, authorization, query, session.login, csrf, `List at most ${MAX_REPOSITORIES} repositories.`)
    const principal: UserPrincipal = { kind: 'user', id: session.userId, login: session.login, limits: null, tokenId: null }
    const resolved = await resolveRepositories(principal, names)
    if ('missing' in resolved) return consent(request, url, authorization, query, session.login, csrf, `Unknown repository: ${resolved.missing}`)
    const code = await agents.createCode({
      clientId: authorization.client.id,
      userId: session.userId,
      redirectUri: authorization.redirect.uri,
      codeChallenge: authorization.codeChallenge,
      resource: authorization.resource,
      name: cleanClientText(form.get('name'), authorization.client.name),
      scope: grantedScope(authorization.scope, form.get('scope')),
      repositoryIds: names.length > 0 ? resolved.ids : null,
    })
    return back({ code })
  }

  const tokenResponse = (issued: Awaited<ReturnType<AgentStore['refresh']>>) =>
    issued
      ? json(200, { access_token: issued.accessToken, token_type: 'Bearer', expires_in: issued.expiresIn, refresh_token: issued.refreshToken, scope: issued.scope })
      : oauthError(400, 'invalid_grant')

  const token = async (request: Request): Promise<Response> => {
    const params = await readParams(request)
    const grant = params.get('grant_type')
    if (grant !== 'authorization_code' && grant !== 'refresh_token') return oauthError(400, 'unsupported_grant_type')
    const client = await agents.findClient(params.get('client_id'))
    if (!client) return oauthError(401, 'invalid_client')
    const target = resolveResource(origin, params.get('resource'))
    if (!target) return oauthError(400, 'invalid_target', `resource must be ${resource}`)
    if (grant === 'refresh_token') return tokenResponse(await agents.refresh({ clientId: client.id, refreshToken: params.get('refresh_token') ?? '', resource: target }))
    return tokenResponse(
      await agents.exchangeCode({
        clientId: client.id,
        code: params.get('code') ?? '',
        codeVerifier: params.get('code_verifier') ?? '',
        redirectUri: params.get('redirect_uri'),
        resource: target,
      }),
    )
  }

  const repositoryNames = async (ids: readonly string[] | null): Promise<string[] | null> =>
    ids === null ? null : (await Promise.all(ids.map((id) => store.findRepositoryById(id)))).flatMap((repository) => (repository ? [`${repository.owner}/${repository.name}`] : []))

  const server: McpServer<McpContext> = {
    name: 'git-forge',
    version: options.version,
    instructions: `Use the token tool to get a short-lived token for ${origin}: Git over HTTPS takes it as the password (any user name), the REST API (${origin}/api/v3) as "Authorization: Bearer". Ask for the lowest scope and the fewest repositories you need.`,
    tools: [
      {
        name: 'token',
        title: 'Get an API token',
        description: 'Issue a short-lived token for Git over HTTPS and the REST API, limited to the access this connection was granted.',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: [...TOKEN_SCOPES], description: 'repo:read, repo:write (includes read) or repo:admin (includes write)' },
            repositories: { type: 'array', items: { type: 'string' }, maxItems: MAX_REPOSITORIES, description: 'owner/name of the repositories the token may use; omit for all the connection allows' },
            ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440, default: 60, description: 'lifetime in minutes' },
          },
          required: ['scope'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        call: async (args, { connection }) => {
          if (!isTokenScope(args.scope)) return toolError('scope must be repo:read, repo:write or repo:admin')
          const requested = args.repositories
          if (requested !== undefined && (!Array.isArray(requested) || requested.length === 0 || requested.length > MAX_REPOSITORIES || !requested.every((name) => typeof name === 'string'))) {
            return toolError(`repositories must list 1 to ${MAX_REPOSITORIES} names like owner/name`)
          }
          const decision = await context.logins.hitRateLimit(AGENT_TOOL_RATE_LIMIT, `agent:${connection.id}`)
          if (!decision.allowed) return toolError(`too many tokens; try again in ${decision.retryAfterSeconds} seconds`)
          const resolved = requested ? await resolveRepositories(user(connection), requested as string[]) : { ids: null }
          if ('missing' in resolved) return toolError(`unknown repository ${resolved.missing}`)
          const clamped = clampAgentToken({ scope: connection.scope, repositoryIds: connection.repositoryIds }, { scope: args.scope, repositoryIds: resolved.ids, ttlMinutes: args.ttl_minutes })
          if ('error' in clamped) return toolError(clamped.error)
          const expiresAt = context.now() + clamped.ttlMs
          const created = await store.createPersonalAccessToken(
            connection.userId,
            { name: `${connection.name} (agent)`, scopes: [clamped.scope], expiresAt, repositoryIds: clamped.repositoryIds, connectionId: connection.id },
            { kind: 'user', id: connection.userId, via: connection.id },
          )
          const repositories = await repositoryNames(clamped.repositoryIds)
          const result = { token: created.token, scope: clamped.scope, repositories, expires_at: new Date(expiresAt).toISOString(), login: connection.login, api: `${origin}/api/v3` }
          return toolResult(
            result,
            `Token for ${connection.login} with ${clamped.scope} on ${repositories ? repositories.join(', ') : 'all repositories'} until ${result.expires_at}: ${created.token}\nGit over HTTPS: use it as the password with any user name. REST API: Authorization: Bearer <token> against ${result.api}.`,
          )
        },
      },
      {
        name: 'whoami',
        title: 'Show this connection',
        description: 'Show the user, connection name and the maximum access this connection can grant.',
        inputSchema: { type: 'object', additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        call: async (_args, { connection }) => {
          const repositories = await repositoryNames(connection.repositoryIds)
          const result = { login: connection.login, connection: connection.name, client: connection.clientName, scope: connection.scope, repositories, instance: origin, api: `${origin}/api/v3` }
          return toolResult(result, `${connection.login} via ${connection.name} on ${origin}, at most ${connection.scope} on ${repositories ? repositories.join(', ') : 'all repositories'}.`)
        },
      },
    ],
  }

  const mcp = async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
    const presentedOrigin = request.headers.get('Origin')
    if (presentedOrigin !== null && presentedOrigin !== origin) return json(403, { jsonrpc: '2.0', error: { code: JSONRPC.invalidRequest, message: 'origin not allowed' } })
    const credential = parseAuthorization(request.headers.get('Authorization'))
    const connection = credential.kind === 'secret' ? await agents.authenticate(credential.secret, resource) : null
    if (!connection) {
      const challenge = `Bearer resource_metadata="${metadataUrl}"${credential.kind === 'none' ? '' : ', error="invalid_token"'}`
      return new Response(JSON.stringify({ error: 'authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': challenge } })
    }
    return handleMcpRequest(server, request, { connection })
  }

  const handles = (pathname: string) =>
    pathname === MCP_PATH ||
    pathname === PROTECTED_RESOURCE_PATH ||
    pathname === `${PROTECTED_RESOURCE_PATH}${MCP_PATH}` ||
    pathname === AUTHORIZATION_SERVER_PATH ||
    pathname === OAUTH_AUTHORIZE_PATH ||
    pathname === OAUTH_TOKEN_PATH ||
    pathname === OAUTH_REGISTER_PATH

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    const { pathname } = url
    if (!handles(pathname)) return null
    const method = request.method
    if (pathname === MCP_PATH) return mcp(request)
    if (method === 'OPTIONS' && pathname !== OAUTH_AUTHORIZE_PATH) return new Response(null, { status: 204, headers: CORS })
    try {
      if (pathname.startsWith(PROTECTED_RESOURCE_PATH) && method === 'GET') return resourceMetadata(pathname)
      if (pathname === AUTHORIZATION_SERVER_PATH && method === 'GET') return serverMetadata()
      if (pathname === OAUTH_REGISTER_PATH && method === 'POST') return (await limited(request, LOGIN_RATE_LIMITS.deviceCode)) ?? (await register(request))
      if (pathname === OAUTH_TOKEN_PATH && method === 'POST') return (await limited(request, LOGIN_RATE_LIMITS.token)) ?? (await token(request))
      if (pathname === OAUTH_AUTHORIZE_PATH && (method === 'GET' || method === 'POST')) {
        if ((await limited(request, LOGIN_RATE_LIMITS.consent)) !== null) return page(request, { kind: 'error', status: 429, message: 'Too many attempts; try again later.' })
        return method === 'GET' ? await authorizePage(request, url) : await decide(request, url)
      }
      return json(405, { error: 'method not allowed' })
    } catch (error) {
      if (!(error instanceof LoginError)) throw error
      return pathname === OAUTH_AUTHORIZE_PATH ? page(request, { kind: 'error', status: error.status, message: error.message }) : oauthError(error.status, 'invalid_request', error.message)
    }
  }
}
