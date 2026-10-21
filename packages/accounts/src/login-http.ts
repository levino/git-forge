import { readAll, SizeLimitError } from '@git-forge/core'
import { AUTHORIZATION_CODE_GRANT, CLI_OOB_REDIRECT, isCliRequestId } from './cli-login.ts'
import { DEVICE_CLIENT_ID, DEVICE_GRANT_TYPE } from './device.ts'
import {
  beginOidcLogin,
  beginPasskeyLogin,
  beginPasskeyRegistration,
  breakGlassLogin,
  completeOidcLogin,
  completePasskeyLogin,
  completePasskeyRegistration,
  decideCliRequest,
  decideDeviceAuthorization,
  DEFAULT_CLI_SCOPE,
  exchangeCliCode,
  LOGIN_CHALLENGE_TTL_MS,
  type LoginContext,
  LoginError,
  lookupDevice,
  lookupCliRequest,
  startCliAuthorization,
  passkeysEnabled,
  pollDeviceToken,
  type RegistrationSubject,
  sessionTtl,
  startDeviceAuthorization,
  startSession,
} from './login.ts'
import type { Session } from './login-store.ts'
import { type LoginPage, type LoginPageRenderer, renderLoginPage } from './login-pages.ts'
import type { UserPrincipal } from './permissions.ts'
import type { RateLimit } from './rate-limit.ts'
import { parseRequestedScope } from './tokens.ts'
import {
  clearCookie,
  CSRF_FIELD,
  CSRF_HEADER,
  cookieNames,
  csrfMatches,
  csrfTokenFor,
  formatCookie,
  isUnsafeMethod,
  parseCookies,
  safeReturnTo,
  sameOrigin,
  type SessionMethod,
} from './sessions.ts'

export type LoginHttpOptions = {
  readonly context: LoginContext
  readonly secureCookies: boolean
  readonly renderPage?: LoginPageRenderer
  readonly clientAddress?: (request: Request) => string | null
}

const MINUTE_MS = 60 * 1000

export const LOGIN_RATE_LIMITS = {
  login: { name: 'login', limit: 60, windowMs: 10 * MINUTE_MS },
  breakGlass: { name: 'break-glass', limit: 10, windowMs: 60 * MINUTE_MS },
  deviceCode: { name: 'device-code', limit: 30, windowMs: 60 * MINUTE_MS },
  token: { name: 'token', limit: 300, windowMs: 10 * MINUTE_MS },
  consent: { name: 'consent', limit: 60, windowMs: 10 * MINUTE_MS },
} as const satisfies Record<string, RateLimit>

const CLI_REQUEST_PATH = /^\/login\/cli\/([A-Za-z0-9_-]+)$/

const cliRequestIdOf = (pathname: string): string | null => {
  const id = CLI_REQUEST_PATH.exec(pathname)?.[1]
  return id && isCliRequestId(id) ? id : null
}

export const loginRateLimitFor = (method: string, pathname: string, search: URLSearchParams): RateLimit | null => {
  if (method === 'POST' && pathname.startsWith('/login/passkey')) return LOGIN_RATE_LIMITS.login
  if (method === 'GET' && (pathname === '/login/oidc' || pathname === '/login/oidc/callback')) return LOGIN_RATE_LIMITS.login
  if (method === 'POST' && pathname === '/login/break-glass') return LOGIN_RATE_LIMITS.breakGlass
  if (method === 'POST' && (pathname === '/login/device/code' || pathname === '/login/cli/start')) return LOGIN_RATE_LIMITS.deviceCode
  if (method === 'POST' && (pathname === '/login/device/token' || pathname === '/login/cli/token')) return LOGIN_RATE_LIMITS.token
  if (pathname === '/login/device' && (method === 'POST' || search.has('user_code'))) return LOGIN_RATE_LIMITS.consent
  if (cliRequestIdOf(pathname) !== null && (method === 'GET' || method === 'POST')) return LOGIN_RATE_LIMITS.consent
  return null
}

export type ActiveSession = {
  readonly session: Session
  readonly token: string
  readonly csrf: string
}

export type SessionCheck = { readonly kind: 'none' } | { readonly kind: 'session'; readonly active: ActiveSession } | { readonly kind: 'csrf-failed' }

const MAX_BODY_BYTES = 64 * 1024

export const MAX_MULTIPART_BYTES = 11 * 1024 * 1024

const json = (status: number, body: unknown, headers: HeadersInit = {}) => {
  const response = new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  for (const [key, value] of new Headers(headers)) response.headers.append(key, value)
  return response
}

const redirect = (location: string, cookies: readonly string[] = []) => {
  const response = new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } })
  for (const cookie of cookies) response.headers.append('Set-Cookie', cookie)
  return response
}

export const sessionTokenOf = (request: Request, secureCookies: boolean): string | null => parseCookies(request.headers.get('Cookie')).get(cookieNames(secureCookies).session) ?? null

export const readActiveSession = async (request: Request, options: LoginHttpOptions): Promise<ActiveSession | null> => {
  const token = sessionTokenOf(request, options.secureCookies)
  if (!token) return null
  const session = await options.context.logins.authenticateSession(token)
  return session ? { session, token, csrf: await csrfTokenFor(token) } : null
}

const presentedCsrf = async (request: Request): Promise<string | null> => {
  const header = request.headers.get(CSRF_HEADER)
  if (header) return header
  const type = request.headers.get('Content-Type') ?? ''
  if (type.startsWith('multipart/form-data')) {
    if (Number(request.headers.get('Content-Length') ?? Infinity) > MAX_MULTIPART_BYTES) return null
    const value = (await request.clone().formData().catch(() => null))?.get(CSRF_FIELD)
    return typeof value === 'string' ? value : null
  }
  if (!type.startsWith('application/x-www-form-urlencoded')) return null
  return (await readForm(request.clone())).get(CSRF_FIELD)
}

export const checkSession = async (request: Request, options: LoginHttpOptions): Promise<SessionCheck> => {
  const active = await readActiveSession(request, options)
  if (!active) return { kind: 'none' }
  if (!isUnsafeMethod(request.method)) return { kind: 'session', active }
  if (!sameOrigin(request, options.context.origin) || !(await csrfMatches(active.token, await presentedCsrf(request)))) return { kind: 'csrf-failed' }
  return { kind: 'session', active }
}

export const sessionUserPrincipal = (session: Session): UserPrincipal => ({ kind: 'user', id: session.userId, login: session.login, limits: null, tokenId: null })

const readText = async (request: Request): Promise<string> => {
  if (!request.body) return ''
  try {
    return new TextDecoder().decode(await readAll(request.body, MAX_BODY_BYTES))
  } catch (error) {
    if (error instanceof SizeLimitError) throw new LoginError('invalid_request', 'request body too large')
    throw error
  }
}

export const readForm = async (request: Request): Promise<URLSearchParams> => new URLSearchParams(await readText(request))

export const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const text = await readText(request)
  if (text.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {}
  throw new LoginError('invalid_request', 'expected a JSON object')
}

export const readParams = async (request: Request): Promise<URLSearchParams> => {
  if ((request.headers.get('Content-Type') ?? '').startsWith('application/json')) {
    const body = await readJson(request)
    return new URLSearchParams(Object.entries(body).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : [])))
  }
  return readForm(request)
}

const stringField = (body: Record<string, unknown>, key: string): string | null => (typeof body[key] === 'string' ? (body[key] as string) : null)

export const createLoginHandler = (options: LoginHttpOptions) => {
  const { context } = options
  const names = cookieNames(options.secureCookies)

  const page = async (request: Request, model: LoginPage): Promise<Response> => (await options.renderPage?.(model, request)) ?? renderLoginPage(model)

  const sessionCookie = (token: string, method: SessionMethod) => formatCookie(names.session, token, { secure: options.secureCookies, maxAgeSeconds: sessionTtl(method) / 1000 })

  const establish = async (request: Request, userId: string, method: SessionMethod): Promise<string> => {
    const created = await startSession(context, { userId }, method, request.headers.get('User-Agent'))
    return sessionCookie(created.token, method)
  }

  const requireSession = async (request: Request): Promise<ActiveSession> => {
    const check = await checkSession(request, options)
    if (check.kind === 'csrf-failed') throw new LoginError('forbidden', 'missing or invalid CSRF token')
    if (check.kind === 'none') throw new LoginError('forbidden', 'sign in first')
    return check.active
  }

  const loginPage = async (request: Request, url: URL, message?: string): Promise<Response> => {
    const active = await readActiveSession(request, options)
    return page(request, {
      kind: 'login',
      returnTo: safeReturnTo(url.searchParams.get('return_to')),
      oidcName: context.oidc?.config.name ?? null,
      selfSignup: context.selfSignup,
      breakGlass: context.breakGlassKey !== null,
      passkeys: passkeysEnabled(context),
      user: active ? { login: active.session.login, csrf: active.csrf } : null,
      ...(message ? { message } : {}),
    })
  }

  const startOidc = async (request: Request, url: URL): Promise<Response> => {
    const invite = url.searchParams.get('invite')
    const link = url.searchParams.get('link') === '1'
    const active = link ? await readActiveSession(request, options) : null
    if (link && !active) return redirect(`/login?return_to=${encodeURIComponent(`/login/oidc?link=1`)}`)
    const intent = active ? ({ kind: 'link', userId: active.session.userId } as const) : invite ? ({ kind: 'invite', code: invite } as const) : ({ kind: 'login' } as const)
    const started = await beginOidcLogin(context, { returnTo: safeReturnTo(url.searchParams.get('return_to')), intent })
    return redirect(started.url, [formatCookie(names.oidc, started.state, { secure: options.secureCookies, maxAgeSeconds: LOGIN_CHALLENGE_TTL_MS / 1000 })])
  }

  const finishOidc = async (request: Request, url: URL): Promise<Response> => {
    const boundState = parseCookies(request.headers.get('Cookie')).get(names.oidc) ?? null
    const result = await completeOidcLogin(context, {
      state: url.searchParams.get('state'),
      code: url.searchParams.get('code'),
      error: url.searchParams.get('error'),
      boundState,
    })
    const cookies = [clearCookie(names.oidc, options.secureCookies)]
    const active = await readActiveSession(request, options)
    if (!active || active.session.userId !== result.userId) cookies.push(await establish(request, result.userId, 'oidc'))
    return redirect(result.returnTo, cookies)
  }

  const passkeyOptions = async (): Promise<Response> => {
    const started = await beginPasskeyLogin(context)
    return json(200, { handle: started.handle, publicKey: started.options })
  }

  const passkeyLogin = async (request: Request): Promise<Response> => {
    const body = await readJson(request)
    const user = await completePasskeyLogin(context, { handle: stringField(body, 'handle') ?? '', credential: body.credential })
    return json(200, { login: user.login }, { 'Set-Cookie': await establish(request, user.userId, 'passkey') })
  }

  const registrationOptions = async (request: Request): Promise<Response> => {
    const check = await checkSession(request, options)
    if (check.kind === 'csrf-failed') throw new LoginError('forbidden', 'missing or invalid CSRF token')
    const body = await readJson(request)
    const invite = stringField(body, 'invite')
    const login = stringField(body, 'login')
    const subject: RegistrationSubject =
      check.kind === 'session'
        ? { kind: 'user', userId: check.active.session.userId }
        : invite
          ? { kind: 'invite', code: invite, login }
          : { kind: 'signup', login: login ?? '' }
    const started = await beginPasskeyRegistration(context, subject)
    return json(200, { handle: started.handle, publicKey: started.options })
  }

  const register = async (request: Request): Promise<Response> => {
    const check = await checkSession(request, options)
    if (check.kind === 'csrf-failed') throw new LoginError('forbidden', 'missing or invalid CSRF token')
    const body = await readJson(request)
    const sessionUserId = check.kind === 'session' ? check.active.session.userId : null
    const user = await completePasskeyRegistration(context, { handle: stringField(body, 'handle') ?? '', credential: body.credential, name: stringField(body, 'name'), sessionUserId })
    const headers: HeadersInit = sessionUserId === user.userId ? {} : { 'Set-Cookie': await establish(request, user.userId, 'passkey') }
    return json(user.created ? 201 : 200, { login: user.login, created: user.created }, headers)
  }

  const invitePage = async (request: Request, code: string): Promise<Response> => {
    const invite = await context.logins.findInvite(code)
    if (!invite) return page(request, { kind: 'error', status: 404, message: 'This invite is invalid, used or expired.' })
    const existing = invite.userId ? await context.store.findUserById(invite.userId) : null
    return page(request, { kind: 'invite', code, login: existing?.login ?? invite.login, existingUser: existing !== null, oidcName: context.oidc?.config.name ?? null, passkeys: passkeysEnabled(context) })
  }

  const clientAddress = (request: Request): string | null => options.clientAddress?.(request) ?? null

  const instance = new URL(context.origin).host

  const signInFirst = (url: URL) => redirect(`/login?return_to=${encodeURIComponent(`${url.pathname}${url.search}`)}`)

  const devicePage = async (request: Request, url: URL): Promise<Response> => {
    const active = await readActiveSession(request, options)
    if (!active) return signInFirst(url)
    const userCode = url.searchParams.get('user_code')
    const base = { kind: 'device', user: { login: active.session.login, csrf: active.csrf }, instance, viewerIp: clientAddress(request) } as const
    if (!userCode) return page(request, { ...base, userCode: null, device: null })
    const device = await lookupDevice(context, userCode)
    if (!device || device.status !== 'pending') return page(request, { ...base, userCode, device: null, message: 'This code is unknown, expired or already used.' })
    return page(request, {
      ...base,
      userCode,
      device: {
        userCode: device.userCode,
        clientName: device.clientName,
        clientHost: device.clientHost,
        requestIp: device.requestIp,
        requestedAt: device.createdAt,
        scope: parseRequestedScope(device.scopes, DEFAULT_CLI_SCOPE) ?? DEFAULT_CLI_SCOPE,
      },
    })
  }

  const decideDevice = async (request: Request): Promise<Response> => {
    const active = await requireSession(request)
    const form = await readForm(request)
    const approve = form.get('decision') === 'approve'
    await decideDeviceAuthorization(context, { userId: active.session.userId, userCode: form.get('user_code') ?? '', approve, scope: form.get('scope') })
    return page(request, { kind: 'device-result', approved: approve })
  }

  const cliPage = async (request: Request, url: URL, id: string): Promise<Response> => {
    const active = await readActiveSession(request, options)
    if (!active) return signInFirst(url)
    const pending = await lookupCliRequest(context, id)
    if (!pending) throw new LoginError('expired', 'This login request is unknown, expired or already answered. Run the login in your terminal again.')
    return page(request, {
      kind: 'cli',
      user: { login: active.session.login, csrf: active.csrf },
      instance,
      request: {
        id,
        clientName: pending.clientName,
        clientHost: pending.clientHost,
        requestIp: pending.requestIp,
        requestedAt: pending.createdAt,
        redirect: pending.redirectUri === CLI_OOB_REDIRECT ? 'oob' : 'loopback',
        redirectUri: pending.redirectUri,
        scope: parseRequestedScope(pending.scopes, DEFAULT_CLI_SCOPE) ?? DEFAULT_CLI_SCOPE,
      },
    })
  }

  const decideCli = async (request: Request, id: string): Promise<Response> => {
    const active = await requireSession(request)
    const form = await readForm(request)
    const decision = await decideCliRequest(context, { userId: active.session.userId, id, approve: form.get('decision') === 'approve', scope: form.get('scope') })
    if (decision.kind === 'redirect') return redirect(decision.location)
    if (decision.kind === 'code') return page(request, { kind: 'cli-code', code: decision.code, expiresAt: decision.expiresAt })
    return page(request, { kind: 'device-result', approved: false })
  }

  const cliStart = async (request: Request): Promise<Response> => {
    const params = await readParams(request)
    try {
      const started = await startCliAuthorization(context, {
        clientId: params.get('client_id'),
        redirectUri: params.get('redirect_uri'),
        codeChallenge: params.get('code_challenge'),
        codeChallengeMethod: params.get('code_challenge_method'),
        state: params.get('state'),
        scope: params.get('scope'),
        clientName: params.get('client_name'),
        clientHost: params.get('client_host'),
        requestIp: clientAddress(request),
      })
      return json(200, { request_id: started.id, authorization_url: started.url, expires_in: started.expiresIn })
    } catch (error) {
      if (error instanceof LoginError) return json(400, { error: error.code === 'invalid_scope' ? 'invalid_scope' : 'invalid_request', error_description: error.message })
      throw error
    }
  }

  const tokenResponse = (result: Awaited<ReturnType<typeof exchangeCliCode>>): Response => {
    if (result.kind === 'error') return json(400, { error: result.error, ...(result.interval ? { interval: result.interval } : {}) })
    return json(200, {
      access_token: result.token,
      token_type: 'bearer',
      scope: result.scope,
      expires_in: Math.round((result.expiresAt - context.now()) / 1000),
      login: result.login,
    })
  }

  const cliToken = async (request: Request): Promise<Response> => {
    const params = await readParams(request)
    if (params.get('grant_type') !== AUTHORIZATION_CODE_GRANT) return json(400, { error: 'unsupported_grant_type' })
    if (params.get('client_id') !== DEVICE_CLIENT_ID) return json(400, { error: 'invalid_client' })
    return tokenResponse(
      await exchangeCliCode(context, { clientId: params.get('client_id'), code: params.get('code'), codeVerifier: params.get('code_verifier'), redirectUri: params.get('redirect_uri') }),
    )
  }

  const deviceCode = async (request: Request): Promise<Response> => {
    const params = await readParams(request)
    try {
      const started = await startDeviceAuthorization(context, {
        clientId: params.get('client_id'),
        clientName: params.get('client_name'),
        clientHost: params.get('client_host'),
        scope: params.get('scope'),
        requestIp: clientAddress(request),
      })
      return json(200, {
        device_code: started.deviceCode,
        user_code: started.userCode,
        verification_uri: started.verificationUri,
        verification_uri_complete: started.verificationUriComplete,
        expires_in: started.expiresIn,
        interval: started.interval,
      })
    } catch (error) {
      if (error instanceof LoginError) return json(400, { error: error.code === 'invalid_scope' ? 'invalid_scope' : 'invalid_client', error_description: error.message })
      throw error
    }
  }

  const deviceToken = async (request: Request): Promise<Response> => {
    const params = await readParams(request)
    if (params.get('grant_type') !== DEVICE_GRANT_TYPE) return json(400, { error: 'unsupported_grant_type' })
    if (params.get('client_id') !== DEVICE_CLIENT_ID) return json(400, { error: 'invalid_client' })
    return tokenResponse(await pollDeviceToken(context, { deviceCode: params.get('device_code'), clientId: params.get('client_id') }))
  }

  const breakGlass = async (request: Request): Promise<Response> => {
    const form = await readForm(request)
    try {
      const user = await breakGlassLogin(context, form.get('token') ?? '')
      return redirect('/login', [await establish(request, user.userId, 'break-glass')])
    } catch (error) {
      if (error instanceof LoginError && error.code !== 'not_configured') return page(request, { kind: 'break-glass', message: error.message })
      throw error
    }
  }

  const logout = async (request: Request): Promise<Response> => {
    const check = await checkSession(request, options)
    if (check.kind === 'csrf-failed') throw new LoginError('forbidden', 'missing or invalid CSRF token')
    if (check.kind === 'session') await context.logins.revokeSession(check.active.token)
    const cookie = clearCookie(names.session, options.secureCookies)
    return (request.headers.get('Accept') ?? '').includes('application/json') ? json(200, { ok: true }, { 'Set-Cookie': cookie }) : redirect('/login', [cookie])
  }

  const sessionInfo = async (request: Request): Promise<Response> => {
    const active = await readActiveSession(request, options)
    if (!active) return json(401, { error: 'not signed in' })
    return json(200, {
      login: active.session.login,
      userId: active.session.userId,
      method: active.session.method,
      expiresAt: active.session.expiresAt,
      csrfToken: active.csrf,
      admin: await context.store.isInstanceAdmin(active.session.userId),
    })
  }

  const requirePasskeys = () => {
    if (!passkeysEnabled(context)) throw new LoginError('not_configured', 'passkeys are disabled on this instance')
  }

  const listPasskeys = async (request: Request): Promise<Response> => {
    requirePasskeys()
    const active = await requireSession(request)
    return json(200, await context.logins.listCredentials(active.session.userId))
  }

  const removePasskey = async (request: Request, id: string): Promise<Response> => {
    requirePasskeys()
    const active = await requireSession(request)
    if (!(await context.logins.revokeCredential(active.session.userId, id))) return json(404, { error: 'no such passkey' })
    return new Response(null, { status: 204 })
  }

  const isPage = (pathname: string) => pathname === '/login' || pathname === '/login/device' || cliRequestIdOf(pathname) !== null || pathname === '/login/break-glass' || pathname.startsWith('/login/invite/') || pathname.startsWith('/login/oidc')

  const dispatch = async (request: Request, url: URL): Promise<Response | null> => {
    const { pathname } = url
    const method = request.method
    if (pathname === '/login' && method === 'GET') return loginPage(request, url)
    if (pathname === '/login/oidc' && method === 'GET') return startOidc(request, url)
    if (pathname === '/login/oidc/callback' && method === 'GET') return finishOidc(request, url)
    if (pathname === '/login/passkey/options' && method === 'POST') return passkeyOptions()
    if (pathname === '/login/passkey' && method === 'POST') return passkeyLogin(request)
    if (pathname === '/login/passkey/register/options' && method === 'POST') return registrationOptions(request)
    if (pathname === '/login/passkey/register' && method === 'POST') return register(request)
    if (pathname === '/login/device' && method === 'GET') return devicePage(request, url)
    if (pathname === '/login/device' && method === 'POST') return decideDevice(request)
    if (pathname === '/login/device/code' && method === 'POST') return deviceCode(request)
    if (pathname === '/login/device/token' && method === 'POST') return deviceToken(request)
    if (pathname === '/login/cli/start' && method === 'POST') return cliStart(request)
    if (pathname === '/login/cli/token' && method === 'POST') return cliToken(request)
    const cliRequest = cliRequestIdOf(pathname)
    if (cliRequest && method === 'GET') return cliPage(request, url, cliRequest)
    if (cliRequest && method === 'POST') return decideCli(request, cliRequest)
    if (pathname === '/login/break-glass' && method === 'GET') {
      if (!context.breakGlassKey) throw new LoginError('not_configured', 'no break-glass key is configured on this instance')
      return page(request, { kind: 'break-glass' })
    }
    if (pathname === '/login/break-glass' && method === 'POST') return breakGlass(request)
    if (pathname === '/logout' && method === 'POST') return logout(request)
    if (pathname === '/api/session' && method === 'GET') return sessionInfo(request)
    if (pathname === '/api/user/passkeys' && method === 'GET') return listPasskeys(request)
    const passkey = /^\/api\/user\/passkeys\/([A-Za-z0-9_-]+)$/.exec(pathname)
    if (passkey && method === 'DELETE') return removePasskey(request, passkey[1]!)
    const invite = /^\/login\/invite\/([A-Za-z0-9_-]+)$/.exec(pathname)
    if (invite && method === 'GET') return invitePage(request, invite[1]!)
    return null
  }

  const handles = (pathname: string) => pathname === '/login' || pathname.startsWith('/login/') || pathname === '/logout' || pathname === '/api/session' || pathname === '/api/user/passkeys' || pathname.startsWith('/api/user/passkeys/')

  const rateLimited = async (request: Request, url: URL, retryAfterSeconds: number): Promise<Response> => {
    const message = `Too many attempts; try again in ${retryAfterSeconds} seconds.`
    const isHtml = (isPage(url.pathname) && request.method === 'GET') || url.pathname === '/login/device' || cliRequestIdOf(url.pathname) !== null || url.pathname === '/login/break-glass'
    const response = isHtml ? await page(request, { kind: 'error', status: 429, message }) : json(429, { error: 'rate_limited', error_description: message })
    const limited = new Response(response.body, response)
    limited.headers.set('Retry-After', String(retryAfterSeconds))
    return limited
  }

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (!handles(url.pathname)) return null
    try {
      if (isUnsafeMethod(request.method) && !sameOrigin(request, context.origin)) throw new LoginError('forbidden', 'cross-origin request refused')
      const limit = loginRateLimitFor(request.method, url.pathname, url.searchParams)
      if (limit) {
        const decision = await context.logins.hitRateLimit(limit, `ip:${clientAddress(request) ?? 'unknown'}`)
        if (!decision.allowed) return rateLimited(request, url, decision.retryAfterSeconds)
      }
      return (await dispatch(request, url)) ?? json(405, { error: 'method not allowed' })
    } catch (error) {
      if (!(error instanceof LoginError)) throw error
      if (isPage(url.pathname) && request.method === 'GET') return page(request, { kind: 'error', status: error.status, message: error.message })
      if (url.pathname === '/login/device' || cliRequestIdOf(url.pathname) !== null || url.pathname === '/login/break-glass') return page(request, { kind: 'error', status: error.status, message: error.message })
      return json(error.status, { error: error.message, code: error.code })
    }
  }
}
