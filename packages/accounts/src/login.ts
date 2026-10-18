import type { OkpPublicJwk } from './jose.ts'
import { BreakGlassError, verifyBreakGlassToken } from './break-glass.ts'
import { DEVICE_CLIENT_ID, DEVICE_TOKEN_TTL_MS, normalizeUserCode } from './device.ts'
import { base64UrlDecode, base64UrlEncode, randomBytes, randomId } from './encoding.ts'
import type { LoginStore, PendingDevice } from './login-store.ts'
import {
  authorizationUrl,
  createPkce,
  exchangeAuthorizationCode,
  type FetchLike,
  OidcError,
  type OidcProvider,
  verifyIdTokenWith,
} from './oidc.ts'
import { BREAK_GLASS_SESSION_TTL_MS, SESSION_TTL_MS, type SessionMethod } from './sessions.ts'
import { type AccountsStore, LOGIN_PATTERN } from './store.ts'
import { assertionCredential, creationOptions, type RelyingParty, requestOptions, verifyAuthentication, verifyRegistration, WebAuthnError } from './webauthn.ts'

export const LOGIN_CHALLENGE_TTL_MS = 10 * 60 * 1000

export const DEVICE_TOKEN_SCOPES = ['repo:write'] as const

export const OIDC_CALLBACK_PATH = '/login/oidc/callback'

export type LoginErrorCode = 'invalid_request' | 'not_configured' | 'no_account' | 'forbidden' | 'expired' | 'verification_failed' | 'conflict'

const STATUS: Record<LoginErrorCode, number> = {
  invalid_request: 400,
  not_configured: 404,
  no_account: 403,
  forbidden: 403,
  expired: 400,
  verification_failed: 401,
  conflict: 409,
}

export class LoginError extends Error {
  readonly status: number

  constructor(
    readonly code: LoginErrorCode,
    message: string,
  ) {
    super(message)
    this.status = STATUS[code]
  }
}

export type LoginContext = {
  readonly store: AccountsStore
  readonly logins: LoginStore
  readonly origin: string
  readonly rp: RelyingParty
  readonly oidc: OidcProvider | null
  readonly selfSignup: boolean
  readonly breakGlassKey: OkpPublicJwk | null
  readonly fetch: FetchLike
  readonly now: () => number
}

export type LoggedInUser = {
  readonly userId: string
  readonly login: string
  readonly created: boolean
}

export const relyingParty = (origin: string, name = 'git-forge'): RelyingParty => ({ id: new URL(origin).hostname, name, origins: [origin] })

export const sessionTtl = (method: SessionMethod): number => (method === 'break-glass' ? BREAK_GLASS_SESSION_TTL_MS : SESSION_TTL_MS)

export const startSession = (context: LoginContext, user: { readonly userId: string }, method: SessionMethod, userAgent: string | null = null) =>
  context.logins.createSession({ userId: user.userId, method, ttlMs: sessionTtl(method), userAgent })

const sanitizeLogin = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 39)
    .replace(/-+$/, '')

export const loginCandidates = (claims: { readonly preferredUsername: string | null; readonly email: string | null; readonly name: string | null }): string[] => {
  const raw = [claims.preferredUsername?.split('@')[0], claims.email?.split('@')[0], claims.name].filter((value): value is string => !!value)
  const cleaned = raw.map(sanitizeLogin).filter((value) => LOGIN_PATTERN.test(value))
  return [...new Set([...cleaned, 'user'])]
}

export const chooseLogin = async (candidates: readonly string[], taken: (login: string) => Promise<boolean>): Promise<string> => {
  for (const candidate of candidates) if (!(await taken(candidate))) return candidate
  const base = (candidates[0] ?? 'user').slice(0, 32)
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!(await taken(candidate))) return candidate
  }
  return `${base.slice(0, 26)}-${base64UrlEncode(randomBytes(6)).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`
}

const isTaken = (context: LoginContext) => async (login: string) => (await context.store.findAccount(login)) !== null

const requireFreeLogin = async (context: LoginContext, login: unknown): Promise<string> => {
  if (typeof login !== 'string' || !LOGIN_PATTERN.test(login)) throw new LoginError('invalid_request', 'choose a login of letters, digits and single hyphens (at most 39 characters)')
  if (await isTaken(context)(login)) throw new LoginError('conflict', `${login} is already taken`)
  return login
}

const requireOidc = (context: LoginContext): OidcProvider => {
  if (!context.oidc) throw new LoginError('not_configured', 'OIDC login is not configured on this instance')
  return context.oidc
}

export type OidcIntent = { readonly kind: 'login' } | { readonly kind: 'link'; readonly userId: string } | { readonly kind: 'invite'; readonly code: string }

export type OidcStart = {
  readonly url: string
  readonly state: string
}

export const beginOidcLogin = async (context: LoginContext, input: { readonly returnTo: string; readonly intent: OidcIntent }): Promise<OidcStart> => {
  const provider = requireOidc(context)
  if (input.intent.kind === 'invite' && !(await context.logins.findInvite(input.intent.code))) throw new LoginError('expired', 'this invite is invalid, used or expired')
  const metadata = await provider.metadata()
  const pkce = await createPkce()
  const nonce = base64UrlEncode(randomBytes(16))
  const state = await context.logins.putChallenge('oidc', { nonce, verifier: pkce.verifier, returnTo: input.returnTo, intent: input.intent }, LOGIN_CHALLENGE_TTL_MS)
  const url = authorizationUrl({
    metadata,
    client: provider.config,
    redirectUri: `${context.origin}${OIDC_CALLBACK_PATH}`,
    state,
    nonce,
    codeChallenge: pkce.challenge,
  })
  return { url, state }
}

export type OidcCompletion = LoggedInUser & { readonly returnTo: string; readonly linked: boolean }

const resolveOidcUser = async (
  context: LoginContext,
  intent: OidcIntent,
  identity: { readonly issuer: string; readonly subject: string; readonly email: string | null; readonly candidates: readonly string[]; readonly displayName: string | null },
): Promise<LoggedInUser & { readonly linked: boolean }> => {
  const existing = await context.store.findUserByExternalIdentity(identity.issuer, identity.subject)
  const link = { issuer: identity.issuer, subject: identity.subject, ...(identity.email ? { email: identity.email } : {}) }
  if (intent.kind === 'link') {
    if (existing && existing.id !== intent.userId) throw new LoginError('conflict', `this identity already belongs to ${existing.login}`)
    const user = await context.store.findUserById(intent.userId)
    if (!user) throw new LoginError('forbidden', 'the account to link no longer exists')
    if (!existing) await context.store.linkExternalIdentity(user.id, link, { kind: 'user', id: user.id })
    return { userId: user.id, login: user.login, created: false, linked: !existing }
  }
  if (existing) return { userId: existing.id, login: existing.login, created: false, linked: false }
  if (intent.kind === 'invite') {
    const invite = await context.logins.findInvite(intent.code)
    if (!invite) throw new LoginError('expired', 'this invite is invalid, used or expired')
    if (invite.userId) {
      const user = await context.store.findUserById(invite.userId)
      if (!user) throw new LoginError('forbidden', 'the invited account no longer exists')
      if (!(await context.logins.redeemInvite(intent.code, user.id))) throw new LoginError('expired', 'this invite was used in the meantime')
      await context.store.linkExternalIdentity(user.id, link, { kind: 'user', id: user.id })
      return { userId: user.id, login: user.login, created: false, linked: true }
    }
    const login = invite.login ? await requireFreeLogin(context, invite.login) : await chooseLogin(identity.candidates, isTaken(context))
    return createLinkedUser(context, { login, email: invite.email ?? identity.email, displayName: identity.displayName, link, invite: intent.code })
  }
  if (!context.selfSignup) throw new LoginError('no_account', 'there is no account for this identity; ask an instance admin for an invite')
  const login = await chooseLogin(identity.candidates, isTaken(context))
  return createLinkedUser(context, { login, email: identity.email, displayName: identity.displayName, link, invite: null })
}

const createLinkedUser = async (
  context: LoginContext,
  input: {
    readonly login: string
    readonly email: string | null
    readonly displayName: string | null
    readonly link: { readonly issuer: string; readonly subject: string; readonly email?: string }
    readonly invite: string | null
  },
): Promise<LoggedInUser & { readonly linked: boolean }> => {
  const id = randomId()
  if (input.invite && !(await context.logins.redeemInvite(input.invite, id))) throw new LoginError('expired', 'this invite was used in the meantime')
  await context.store.createUser(
    { id, login: input.login, ...(input.email ? { email: input.email } : {}), ...(input.displayName ? { displayName: input.displayName } : {}) },
    { kind: 'user', id },
  )
  await context.store.linkExternalIdentity(id, input.link, { kind: 'user', id })
  return { userId: id, login: input.login, created: true, linked: true }
}

const intentOf = (value: unknown): OidcIntent => {
  const intent = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  if (intent.kind === 'link' && typeof intent.userId === 'string') return { kind: 'link', userId: intent.userId }
  if (intent.kind === 'invite' && typeof intent.code === 'string') return { kind: 'invite', code: intent.code }
  return { kind: 'login' }
}

export const completeOidcLogin = async (
  context: LoginContext,
  input: { readonly state: string | null; readonly code: string | null; readonly boundState: string | null; readonly error?: string | null },
): Promise<OidcCompletion> => {
  const provider = requireOidc(context)
  if (!input.state || input.boundState !== input.state) throw new LoginError('invalid_request', 'this login was started in another browser or has expired; start again')
  const data = await context.logins.takeChallenge('oidc', input.state)
  if (!data) throw new LoginError('expired', 'this login has expired; start again')
  if (input.error) throw new LoginError('verification_failed', `the identity provider refused the login: ${input.error}`)
  if (!input.code) throw new LoginError('invalid_request', 'the identity provider sent no code')
  const metadata = await provider.metadata()
  let claims
  try {
    const idToken = await exchangeAuthorizationCode(
      { metadata, client: provider.config, code: input.code, redirectUri: `${context.origin}${OIDC_CALLBACK_PATH}`, codeVerifier: String(data.verifier) },
      context.fetch,
    )
    claims = await verifyIdTokenWith(provider, idToken, { nonce: String(data.nonce), now: context.now() })
  } catch (error) {
    if (error instanceof OidcError) throw new LoginError('verification_failed', error.message)
    throw error
  }
  const user = await resolveOidcUser(context, intentOf(data.intent), {
    issuer: provider.config.issuer,
    subject: claims.sub,
    email: claims.email && claims.emailVerified ? claims.email : null,
    candidates: loginCandidates(claims),
    displayName: claims.name,
  })
  await context.logins.touchExternalIdentity(provider.config.issuer, claims.sub)
  return { ...user, returnTo: typeof data.returnTo === 'string' ? data.returnTo : '/' }
}

export type RegistrationSubject =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'invite'; readonly code: string; readonly login?: string | null }
  | { readonly kind: 'signup'; readonly login: string }

type RegistrationTarget = { readonly userId: string; readonly login: string; readonly create: boolean; readonly invite: string | null }

const registrationTarget = async (context: LoginContext, subject: RegistrationSubject): Promise<RegistrationTarget> => {
  if (subject.kind === 'user') {
    const user = await context.store.findUserById(subject.userId)
    if (!user) throw new LoginError('forbidden', 'unknown account')
    return { userId: user.id, login: user.login, create: false, invite: null }
  }
  if (subject.kind === 'invite') {
    const invite = await context.logins.findInvite(subject.code)
    if (!invite) throw new LoginError('expired', 'this invite is invalid, used or expired')
    if (invite.userId) {
      const user = await context.store.findUserById(invite.userId)
      if (!user) throw new LoginError('forbidden', 'the invited account no longer exists')
      return { userId: user.id, login: user.login, create: false, invite: subject.code }
    }
    return { userId: randomId(), login: await requireFreeLogin(context, invite.login ?? subject.login), create: true, invite: subject.code }
  }
  if (!context.selfSignup) throw new LoginError('forbidden', 'self-signup is disabled on this instance; ask an instance admin for an invite')
  return { userId: randomId(), login: await requireFreeLogin(context, subject.login), create: true, invite: null }
}

export type CeremonyStart<T> = {
  readonly handle: string
  readonly options: T
}

export const beginPasskeyRegistration = async (context: LoginContext, subject: RegistrationSubject): Promise<CeremonyStart<ReturnType<typeof creationOptions>>> => {
  const target = await registrationTarget(context, subject)
  const userHandle = (target.create ? null : await context.logins.userHandleFor(target.userId)) ?? base64UrlEncode(randomBytes(32))
  const challenge = randomBytes(32)
  const existing = target.create ? [] : await context.logins.listCredentials(target.userId)
  const handle = await context.logins.putChallenge('passkey-register', { ...target, userHandle, challenge: base64UrlEncode(challenge) }, LOGIN_CHALLENGE_TTL_MS)
  const options = creationOptions({
    rp: context.rp,
    user: { handle: base64UrlDecode(userHandle), name: target.login, displayName: target.login },
    challenge,
    excludeCredentials: existing.map((credential) => credential.id),
  })
  return { handle, options }
}

const verifying = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    if (error instanceof WebAuthnError) throw new LoginError('verification_failed', error.message)
    throw error
  }
}

export const completePasskeyRegistration = async (
  context: LoginContext,
  input: { readonly handle: string; readonly credential: unknown; readonly name?: string | null; readonly sessionUserId?: string | null },
): Promise<LoggedInUser> => {
  const data = await context.logins.takeChallenge('passkey-register', input.handle)
  if (!data) throw new LoginError('expired', 'this registration has expired; start again')
  const target = data as unknown as RegistrationTarget & { readonly userHandle: string; readonly challenge: string }
  if (!target.create && !target.invite && input.sessionUserId !== target.userId) throw new LoginError('forbidden', 'log in to add a passkey to this account')
  const verified = await verifying(() => verifyRegistration({ credential: input.credential, challenge: target.challenge, rp: context.rp }))
  if (await context.logins.findCredential(verified.credentialId)) throw new LoginError('conflict', 'this passkey is already registered')
  if (target.invite && !(await context.logins.redeemInvite(target.invite, target.userId))) throw new LoginError('expired', 'this invite was used in the meantime')
  if (target.create) {
    if (await isTaken(context)(target.login)) throw new LoginError('conflict', `${target.login} was taken in the meantime`)
    await context.store.createUser({ id: target.userId, login: target.login }, { kind: 'user', id: target.userId })
  }
  const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim().slice(0, 100) : 'passkey'
  await context.logins.addCredential({
    id: verified.credentialId,
    userId: target.userId,
    userHandle: target.userHandle,
    publicKey: verified.publicKey,
    signCount: verified.signCount,
    transports: verified.transports,
    aaguid: verified.aaguid,
    backupEligible: verified.backupEligible,
    name,
  })
  return { userId: target.userId, login: target.login, created: target.create }
}

export const beginPasskeyLogin = async (context: LoginContext): Promise<CeremonyStart<ReturnType<typeof requestOptions>>> => {
  const challenge = randomBytes(32)
  const handle = await context.logins.putChallenge('passkey-login', { challenge: base64UrlEncode(challenge) }, LOGIN_CHALLENGE_TTL_MS)
  return { handle, options: requestOptions({ rp: context.rp, challenge }) }
}

export const completePasskeyLogin = async (context: LoginContext, input: { readonly handle: string; readonly credential: unknown }): Promise<LoggedInUser> => {
  const data = await context.logins.takeChallenge('passkey-login', input.handle)
  if (!data) throw new LoginError('expired', 'this login has expired; start again')
  const presented = await verifying(async () => assertionCredential(input.credential))
  const stored = await context.logins.findCredential(presented.credentialId)
  if (!stored) throw new LoginError('verification_failed', 'unknown passkey')
  if (presented.userHandle !== null && presented.userHandle !== stored.userHandle) throw new LoginError('verification_failed', 'the passkey belongs to another account')
  const verified = await verifying(() =>
    verifyAuthentication({ credential: input.credential, challenge: String(data.challenge), rp: context.rp, publicKey: stored.publicKey, storedSignCount: stored.signCount }),
  )
  if (!(await context.logins.recordCredentialUse(stored.id, stored.signCount, verified.signCount))) throw new LoginError('verification_failed', 'the passkey was used concurrently; try again')
  return { userId: stored.userId, login: stored.login, created: false }
}

export type DeviceStart = {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string
  readonly expiresIn: number
  readonly interval: number
}

export const DEVICE_PATH = '/login/device'

export const startDeviceAuthorization = async (context: LoginContext, input: { readonly clientId: string | null; readonly clientName?: string | null }): Promise<DeviceStart> => {
  if (input.clientId !== DEVICE_CLIENT_ID) throw new LoginError('invalid_request', `unknown client_id; use ${DEVICE_CLIENT_ID}`)
  const name = typeof input.clientName === 'string' && input.clientName.trim() !== '' ? input.clientName.trim() : 'git forge auth login'
  const device = await context.logins.createDevice({ clientName: name, scopes: DEVICE_TOKEN_SCOPES.join(' ') })
  const verificationUri = `${context.origin}${DEVICE_PATH}`
  return {
    deviceCode: device.deviceCode,
    userCode: device.userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(device.userCode)}`,
    expiresIn: Math.round((device.expiresAt - context.now()) / 1000),
    interval: device.intervalSeconds,
  }
}

export const lookupDevice = async (context: LoginContext, userCode: string): Promise<PendingDevice | null> => {
  const normalized = normalizeUserCode(userCode)
  return normalized ? context.logins.findDevice(normalized) : null
}

export const decideDeviceAuthorization = async (context: LoginContext, input: { readonly userId: string; readonly userCode: string; readonly approve: boolean }): Promise<void> => {
  const normalized = normalizeUserCode(input.userCode)
  if (!normalized) throw new LoginError('invalid_request', 'the code has the wrong format')
  if (!(await context.logins.decideDevice(normalized, input.userId, input.approve))) throw new LoginError('expired', 'this code is unknown, expired or already used')
}

export type DeviceTokenResult =
  | { readonly kind: 'token'; readonly token: string; readonly login: string; readonly scope: string; readonly expiresAt: number }
  | { readonly kind: 'error'; readonly error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'invalid_grant'; readonly interval?: number }

export const pollDeviceToken = async (context: LoginContext, input: { readonly deviceCode: string | null; readonly clientId: string | null }): Promise<DeviceTokenResult> => {
  if (input.clientId !== DEVICE_CLIENT_ID || !input.deviceCode) return { kind: 'error', error: 'invalid_grant' }
  const poll = await context.logins.pollDevice(input.deviceCode)
  if (!poll) return { kind: 'error', error: 'invalid_grant' }
  if (poll.outcome.kind === 'slow_down') return { kind: 'error', error: 'slow_down', interval: poll.outcome.intervalSeconds }
  if (poll.outcome.kind !== 'approved') return { kind: 'error', error: poll.outcome.kind }
  const user = poll.userId ? await context.store.findUserById(poll.userId) : null
  if (!user) return { kind: 'error', error: 'access_denied' }
  const expiresAt = context.now() + DEVICE_TOKEN_TTL_MS
  const created = await context.store.createPersonalAccessToken(
    user.id,
    { name: poll.clientName, scopes: [...DEVICE_TOKEN_SCOPES], expiresAt },
    { kind: 'user', id: user.id },
  )
  await context.logins.attachDeviceToken(input.deviceCode, created.id)
  return { kind: 'token', token: created.token, login: user.login, scope: DEVICE_TOKEN_SCOPES.join(' '), expiresAt }
}

export const breakGlassLogin = async (context: LoginContext, token: string): Promise<LoggedInUser> => {
  if (!context.breakGlassKey) throw new LoginError('not_configured', 'no break-glass key is configured on this instance')
  let claims
  try {
    claims = await verifyBreakGlassToken(token, { publicKey: context.breakGlassKey, audience: context.origin, now: context.now() })
  } catch (error) {
    if (error instanceof BreakGlassError) throw new LoginError('verification_failed', error.message)
    throw error
  }
  if (!(await context.logins.claimOnce('break-glass', claims.jti, claims.exp * 1000))) throw new LoginError('verification_failed', 'this break-glass token was already used')
  const account = await context.store.findAccount(claims.login)
  const user = account && account.kind === 'user' ? await context.store.findUserById(account.id) : null
  if (!user || !(await context.store.isInstanceAdmin(user.id))) throw new LoginError('forbidden', `${claims.login} is not an instance admin`)
  await context.store.recordAudit({ kind: 'user', id: user.id }, { action: 'session.break-glass', subjectKind: 'user', subjectId: user.id, data: { jti: claims.jti } })
  return { userId: user.id, login: user.login, created: false }
}
