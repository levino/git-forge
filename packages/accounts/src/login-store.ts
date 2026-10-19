import { CLI_REQUEST_TTL_MS, generateCliCode, generateCliRequestId, isCliRequestId } from './cli-login.ts'
import { type Database, first, sql } from './database.ts'
import { base64UrlEncode, randomBytes, randomId, sha256Hex } from './encoding.ts'
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  type DevicePollOutcome,
  devicePollOutcome,
  type DeviceStatus,
  generateDeviceCode,
  generateUserCode,
} from './device.ts'
import type { VerificationJwk } from './jose.ts'
import { parseVerificationJwk } from './jose.ts'
import { createRateLimiter, type RateDecision, type RateLimit } from './rate-limit.ts'
import { generateSessionToken, hashSessionToken, isSessionToken, SESSION_TOUCH_RESOLUTION_MS, type SessionMethod } from './sessions.ts'
import { type AuditActor, auditStatement, SYSTEM } from './store.ts'
import type { CoseAlgorithm, CredentialPublicKey } from './webauthn.ts'

export const CHALLENGE_KINDS = ['oidc', 'passkey-register', 'passkey-login', 'break-glass'] as const

export type ChallengeKind = (typeof CHALLENGE_KINDS)[number]

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type Session = {
  readonly id: string
  readonly userId: string
  readonly login: string
  readonly method: SessionMethod
  readonly createdAt: number
  readonly expiresAt: number
  readonly instanceAdmin?: boolean
}

export type CreatedSession = {
  readonly id: string
  readonly token: string
  readonly expiresAt: number
}

export type StoredCredential = {
  readonly id: string
  readonly userId: string
  readonly login: string
  readonly userHandle: string
  readonly publicKey: CredentialPublicKey
  readonly signCount: number
}

export type CredentialSummary = {
  readonly id: string
  readonly name: string
  readonly algorithm: CoseAlgorithm
  readonly backupEligible: boolean
  readonly createdAt: number
  readonly lastUsedAt: number | null
}

export type NewCredential = {
  readonly id: string
  readonly userId: string
  readonly userHandle: string
  readonly publicKey: CredentialPublicKey
  readonly signCount: number
  readonly transports: readonly string[]
  readonly aaguid: string
  readonly backupEligible: boolean
  readonly name: string
}

export type DeviceAuthorization = {
  readonly deviceCode: string
  readonly userCode: string
  readonly expiresAt: number
  readonly intervalSeconds: number
}

export type PendingDevice = {
  readonly userCode: string
  readonly clientName: string
  readonly clientHost: string | null
  readonly requestIp: string | null
  readonly scopes: string
  readonly status: DeviceStatus
  readonly createdAt: number
  readonly expiresAt: number
}

export type NewCliRequest = {
  readonly clientName: string
  readonly clientHost: string | null
  readonly requestIp: string | null
  readonly redirectUri: string
  readonly state: string | null
  readonly codeChallenge: string
  readonly scopes: string
}

export type PendingCliRequest = {
  readonly id: string
  readonly clientName: string
  readonly clientHost: string | null
  readonly requestIp: string | null
  readonly redirectUri: string
  readonly state: string | null
  readonly scopes: string
  readonly createdAt: number
  readonly expiresAt: number
}

type CliRow = {
  client_name: string
  client_host: string | null
  request_ip: string | null
  redirect_uri: string
  state: string | null
  scopes: string
  created_at: number
  expires_at: number
}

export type CliCodeGrant = {
  readonly userId: string
  readonly clientName: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly scopes: string
}

export type PurgeResult = {
  readonly challenges: number
  readonly devices: number
  readonly cliCodes: number
  readonly rateLimits: number
}

export const PURGE_GRACE_MS = 60 * 60 * 1000

export type DevicePoll = {
  readonly outcome: DevicePollOutcome
  readonly userId: string | null
  readonly clientName: string
  readonly scopes: string
}

export type Invite = {
  readonly login: string | null
  readonly userId: string | null
  readonly email: string | null
  readonly expiresAt: number
}

export type CreatedInvite = {
  readonly code: string
  readonly expiresAt: number
}

type SessionRow = { id: string; user_id: string; login: string; method: SessionMethod; created_at: number; expires_at: number; last_seen_at: number }

type CredentialRow = {
  id: string
  user_id: string
  login: string
  user_handle: string
  algorithm: CoseAlgorithm
  public_key: string
  sign_count: number
}

type DeviceRow = {
  user_code: string
  client_name: string
  client_host: string | null
  request_ip: string | null
  created_at: number
  scopes: string
  status: DeviceStatus
  user_id: string | null
  interval_seconds: number
  expires_at: number
  last_polled_at: number | null
}

const userActor = (userId: string): AuditActor => ({ kind: 'user', id: userId })

const handleHash = (handle: string): Promise<string> => sha256Hex(`git-forge login handle\n${handle}`)

export const generateInviteCode = (): string => `gfi_${base64UrlEncode(randomBytes(24))}`

export const createLoginStore = (db: Database, options: { readonly now?: () => number } = {}) => {
  const now = options.now ?? Date.now

  const parsePublicKey = (row: CredentialRow): CredentialPublicKey => {
    const jwk = parseVerificationJwk(JSON.parse(row.public_key)) as VerificationJwk | null
    if (!jwk) throw new Error(`stored credential ${row.id} has an unusable public key`)
    return { algorithm: row.algorithm, jwk }
  }

  return {
    createSession: async (input: { readonly userId: string; readonly method: SessionMethod; readonly ttlMs: number; readonly userAgent?: string | null }): Promise<CreatedSession> => {
      const token = generateSessionToken()
      const id = randomId()
      const at = now()
      const expiresAt = at + input.ttlMs
      await db.batch([
        sql(
          'INSERT INTO sessions (id, token_hash, user_id, method, user_agent, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id,
          await hashSessionToken(token),
          input.userId,
          input.method,
          input.userAgent?.slice(0, 256) ?? null,
          at,
          expiresAt,
          at,
        ),
        auditStatement(userActor(input.userId), { action: 'session.create', subjectKind: 'session', subjectId: id, data: { method: input.method } }, at),
      ])
      return { id, token, expiresAt }
    },

    authenticateSession: async (token: string): Promise<Session | null> => {
      if (!isSessionToken(token)) return null
      const at = now()
      const row = await first<SessionRow & { instance_admin: number }>(
        db,
        sql(
          `SELECT s.id, s.user_id, a.login, s.method, s.created_at, s.expires_at, s.last_seen_at, EXISTS (SELECT 1 FROM instance_admins i WHERE i.user_id = s.user_id) AS instance_admin
           FROM sessions s JOIN accounts a ON a.id = s.user_id
           WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.disabled_at IS NULL AND a.kind = 'user'`,
          await hashSessionToken(token),
          at,
        ),
      )
      if (!row) return null
      if (at - row.last_seen_at >= SESSION_TOUCH_RESOLUTION_MS) await db.run(sql('UPDATE sessions SET last_seen_at = ? WHERE id = ?', at, row.id))
      return { id: row.id, userId: row.user_id, login: row.login, method: row.method, createdAt: row.created_at, expiresAt: row.expires_at, instanceAdmin: row.instance_admin === 1 }
    },

    revokeSession: async (token: string): Promise<void> => {
      if (!isSessionToken(token)) return
      const row = await first<{ id: string; user_id: string }>(
        db,
        sql('SELECT id, user_id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL', await hashSessionToken(token)),
      )
      if (!row) return
      const at = now()
      await db.batch([
        sql('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', at, row.id),
        auditStatement(userActor(row.user_id), { action: 'session.revoke', subjectKind: 'session', subjectId: row.id }, at),
      ])
    },

    revokeUserSession: async (userId: string, id: string): Promise<boolean> => {
      const active = await first(db, sql('SELECT 1 AS ok FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL', id, userId))
      if (!active) return false
      const at = now()
      await db.batch([
        sql('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', at, id, userId),
        auditStatement(userActor(userId), { action: 'session.revoke', subjectKind: 'session', subjectId: id }, at),
      ])
      return true
    },

    revokeUserSessions: async (userId: string, actor: AuditActor = SYSTEM): Promise<void> => {
      const at = now()
      await db.batch([
        sql('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', at, userId),
        auditStatement(actor, { action: 'session.revoke-all', subjectKind: 'user', subjectId: userId }, at),
      ])
    },

    listSessions: async (userId: string) =>
      (
        await db.all<{ id: string; method: SessionMethod; user_agent: string | null; created_at: number; expires_at: number; last_seen_at: number }>(
          sql(
            'SELECT id, method, user_agent, created_at, expires_at, last_seen_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
            userId,
            now(),
          ),
        )
      ).map((row) => ({ id: row.id, method: row.method, userAgent: row.user_agent, createdAt: row.created_at, expiresAt: row.expires_at, lastSeenAt: row.last_seen_at })),

    putChallenge: async (kind: ChallengeKind, data: Record<string, unknown>, ttlMs: number): Promise<string> => {
      const handle = base64UrlEncode(randomBytes(32))
      const at = now()
      await db.run(
        sql('INSERT INTO login_challenges (id_hash, kind, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', await handleHash(handle), kind, JSON.stringify(data), at, at + ttlMs),
      )
      return handle
    },

    takeChallenge: async (kind: ChallengeKind, handle: string): Promise<Record<string, unknown> | null> => {
      if (typeof handle !== 'string' || handle.length === 0 || handle.length > 128) return null
      const id = await handleHash(handle)
      const at = now()
      const row = await first<{ data: string }>(db, sql('SELECT data FROM login_challenges WHERE id_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?', id, kind, at))
      if (!row) return null
      const claimed = await db.run(sql('UPDATE login_challenges SET used_at = ? WHERE id_hash = ? AND used_at IS NULL', at, id))
      return claimed.changes === 1 ? (JSON.parse(row.data) as Record<string, unknown>) : null
    },

    claimOnce: async (kind: ChallengeKind, key: string, expiresAt: number): Promise<boolean> => {
      const at = now()
      const result = await db.run(
        sql('INSERT INTO login_challenges (id_hash, kind, data, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id_hash) DO NOTHING', await handleHash(`${kind}\n${key}`), kind, '{}', at, expiresAt, at),
      )
      return result.changes === 1
    },

    addCredential: async (credential: NewCredential, actor: AuditActor = userActor(credential.userId)): Promise<void> => {
      const at = now()
      await db.batch([
        sql(
          `INSERT INTO webauthn_credentials (id, user_id, user_handle, algorithm, public_key, sign_count, transports, aaguid, backup_eligible, name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          credential.id,
          credential.userId,
          credential.userHandle,
          credential.publicKey.algorithm,
          JSON.stringify(credential.publicKey.jwk),
          credential.signCount,
          JSON.stringify(credential.transports),
          credential.aaguid,
          credential.backupEligible ? 1 : 0,
          credential.name,
          at,
        ),
        auditStatement(actor, { action: 'passkey.add', subjectKind: 'user', subjectId: credential.userId, data: { credentialId: credential.id, aaguid: credential.aaguid } }, at),
      ])
    },

    findCredential: async (id: string): Promise<StoredCredential | null> => {
      const row = await first<CredentialRow>(
        db,
        sql(
          `SELECT c.id, c.user_id, a.login, c.user_handle, c.algorithm, c.public_key, c.sign_count
           FROM webauthn_credentials c JOIN accounts a ON a.id = c.user_id
           WHERE c.id = ? AND c.revoked_at IS NULL AND a.disabled_at IS NULL`,
          id,
        ),
      )
      return row ? { id: row.id, userId: row.user_id, login: row.login, userHandle: row.user_handle, publicKey: parsePublicKey(row), signCount: row.sign_count } : null
    },

    recordCredentialUse: async (id: string, previousCount: number, signCount: number): Promise<boolean> => {
      const result = await db.run(sql('UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ? WHERE id = ? AND sign_count = ?', signCount, now(), id, previousCount))
      return result.changes === 1
    },

    userHandleFor: async (userId: string): Promise<string | null> =>
      (await first<{ user_handle: string }>(db, sql('SELECT user_handle FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at LIMIT 1', userId)))?.user_handle ?? null,

    listCredentials: async (userId: string): Promise<CredentialSummary[]> =>
      (
        await db.all<{ id: string; name: string; algorithm: CoseAlgorithm; backup_eligible: number; created_at: number; last_used_at: number | null }>(
          sql('SELECT id, name, algorithm, backup_eligible, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at', userId),
        )
      ).map((row) => ({ id: row.id, name: row.name, algorithm: row.algorithm, backupEligible: row.backup_eligible === 1, createdAt: row.created_at, lastUsedAt: row.last_used_at })),

    revokeCredential: async (userId: string, id: string, actor: AuditActor = userActor(userId)): Promise<boolean> => {
      const at = now()
      const result = await db.run(sql('UPDATE webauthn_credentials SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', at, id, userId))
      if (result.changes !== 1) return false
      await db.run(auditStatement(actor, { action: 'passkey.revoke', subjectKind: 'user', subjectId: userId, data: { credentialId: id } }, at))
      return true
    },

    createDevice: async (input: { readonly clientName: string; readonly scopes: string; readonly clientHost?: string | null; readonly requestIp?: string | null }): Promise<DeviceAuthorization> => {
      const deviceCode = generateDeviceCode()
      const at = now()
      const expiresAt = at + DEVICE_CODE_TTL_SECONDS * 1000
      for (let attempt = 0; attempt < 5; attempt++) {
        const userCode = generateUserCode()
        const result = await db.run(
          sql(
            `INSERT INTO device_authorizations (device_code_hash, user_code, client_name, client_host, request_ip, scopes, status, interval_seconds, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT (user_code) DO NOTHING`,
            await handleHash(deviceCode),
            userCode,
            input.clientName.slice(0, 100),
            input.clientHost?.slice(0, 100) ?? null,
            input.requestIp?.slice(0, 64) ?? null,
            input.scopes,
            DEVICE_POLL_INTERVAL_SECONDS,
            at,
            expiresAt,
          ),
        )
        if (result.changes === 1) return { deviceCode, userCode, expiresAt, intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS }
      }
      throw new Error('could not allocate a unique user code')
    },

    findDevice: async (userCode: string): Promise<PendingDevice | null> => {
      const row = await first<DeviceRow>(db, sql('SELECT user_code, client_name, client_host, request_ip, created_at, scopes, status, user_id, interval_seconds, expires_at, last_polled_at FROM device_authorizations WHERE user_code = ?', userCode))
      if (!row || row.expires_at <= now()) return null
      return {
        userCode: row.user_code,
        clientName: row.client_name,
        clientHost: row.client_host,
        requestIp: row.request_ip,
        scopes: row.scopes,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }
    },

    decideDevice: async (userCode: string, userId: string, decision: { readonly approve: false } | { readonly approve: true; readonly scopes: string }): Promise<boolean> => {
      const at = now()
      const result = await db.run(
        decision.approve
          ? sql(
              "UPDATE device_authorizations SET status = 'approved', scopes = ?, user_id = ?, decided_at = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?",
              decision.scopes,
              userId,
              at,
              userCode,
              at,
            )
          : sql("UPDATE device_authorizations SET status = 'denied', user_id = ?, decided_at = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?", userId, at, userCode, at),
      )
      if (result.changes !== 1) return false
      await db.run(
        auditStatement(
          userActor(userId),
          { action: decision.approve ? 'device.approve' : 'device.deny', subjectKind: 'device', subjectId: userCode, ...(decision.approve ? { data: { scopes: decision.scopes } } : {}) },
          at,
        ),
      )
      return true
    },

    pollDevice: async (deviceCode: string): Promise<DevicePoll | null> => {
      if (typeof deviceCode !== 'string' || deviceCode.length > 128) return null
      const id = await handleHash(deviceCode)
      const row = await first<DeviceRow>(db, sql('SELECT user_code, client_name, client_host, request_ip, created_at, scopes, status, user_id, interval_seconds, expires_at, last_polled_at FROM device_authorizations WHERE device_code_hash = ?', id))
      if (!row) return null
      const at = now()
      const outcome = devicePollOutcome({ status: row.status, expiresAt: row.expires_at, intervalSeconds: row.interval_seconds, lastPolledAt: row.last_polled_at }, at)
      if (outcome.kind === 'slow_down') {
        await db.run(sql('UPDATE device_authorizations SET interval_seconds = ?, last_polled_at = ? WHERE device_code_hash = ?', outcome.intervalSeconds, at, id))
      } else if (outcome.kind === 'approved') {
        const claimed = await db.run(sql("UPDATE device_authorizations SET status = 'consumed', last_polled_at = ? WHERE device_code_hash = ? AND status = 'approved'", at, id))
        if (claimed.changes !== 1) return { outcome: { kind: 'expired_token' }, userId: null, clientName: row.client_name, scopes: row.scopes }
      } else {
        await db.run(sql('UPDATE device_authorizations SET last_polled_at = ? WHERE device_code_hash = ?', at, id))
      }
      return { outcome, userId: row.user_id, clientName: row.client_name, scopes: row.scopes }
    },

    attachDeviceToken: async (deviceCode: string, tokenId: string): Promise<void> => {
      await db.run(sql('UPDATE device_authorizations SET token_id = ? WHERE device_code_hash = ?', tokenId, await handleHash(deviceCode)))
    },

    createCliRequest: async (input: NewCliRequest): Promise<{ readonly id: string; readonly expiresAt: number }> => {
      const id = generateCliRequestId()
      const at = now()
      const expiresAt = at + CLI_REQUEST_TTL_MS
      await db.run(
        sql(
          `INSERT INTO cli_authorizations (id_hash, status, client_name, client_host, request_ip, redirect_uri, state, code_challenge, scopes, created_at, expires_at)
           VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          await handleHash(id),
          input.clientName.slice(0, 100),
          input.clientHost?.slice(0, 100) ?? null,
          input.requestIp?.slice(0, 64) ?? null,
          input.redirectUri,
          input.state,
          input.codeChallenge,
          input.scopes,
          at,
          expiresAt,
        ),
      )
      return { id, expiresAt }
    },

    findCliRequest: async (id: string): Promise<PendingCliRequest | null> => {
      if (!isCliRequestId(id)) return null
      const row = await first<CliRow>(
        db,
        sql(
          "SELECT client_name, client_host, request_ip, redirect_uri, state, scopes, created_at, expires_at FROM cli_authorizations WHERE id_hash = ? AND status = 'pending' AND expires_at > ?",
          await handleHash(id),
          now(),
        ),
      )
      return row
        ? {
            id,
            clientName: row.client_name,
            clientHost: row.client_host,
            requestIp: row.request_ip,
            redirectUri: row.redirect_uri,
            state: row.state,
            scopes: row.scopes,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          }
        : null
    },

    decideCliRequest: async (
      id: string,
      userId: string,
      decision: { readonly approve: false } | { readonly approve: true; readonly scopes: string },
    ): Promise<{ readonly code: string | null; readonly expiresAt: number } | null> => {
      if (!isCliRequestId(id)) return null
      const hash = await handleHash(id)
      const at = now()
      const code = decision.approve ? generateCliCode() : null
      const result = await db.run(
        decision.approve
          ? sql(
              "UPDATE cli_authorizations SET status = 'approved', code_hash = ?, scopes = ?, user_id = ?, decided_at = ? WHERE id_hash = ? AND status = 'pending' AND expires_at > ?",
              await handleHash(code!),
              decision.scopes,
              userId,
              at,
              hash,
              at,
            )
          : sql("UPDATE cli_authorizations SET status = 'denied', user_id = ?, decided_at = ? WHERE id_hash = ? AND status = 'pending' AND expires_at > ?", userId, at, hash, at),
      )
      if (result.changes !== 1) return null
      await db.run(
        auditStatement(
          userActor(userId),
          { action: decision.approve ? 'cli.approve' : 'cli.deny', subjectKind: 'cli-authorization', subjectId: hash.slice(0, 16), ...(decision.approve ? { data: { scopes: decision.scopes } } : {}) },
          at,
        ),
      )
      const row = await first<{ expires_at: number }>(db, sql('SELECT expires_at FROM cli_authorizations WHERE id_hash = ?', hash))
      return { code, expiresAt: row?.expires_at ?? at }
    },

    takeCliCode: async (code: string): Promise<CliCodeGrant | null> => {
      if (typeof code !== 'string' || !code.startsWith('gfc_') || code.length > 64) return null
      const hash = await handleHash(code)
      const at = now()
      const row = await first<{ user_id: string; client_name: string; redirect_uri: string; code_challenge: string; scopes: string }>(
        db,
        sql("SELECT user_id, client_name, redirect_uri, code_challenge, scopes FROM cli_authorizations WHERE code_hash = ? AND status = 'approved' AND expires_at > ?", hash, at),
      )
      if (!row) return null
      const claimed = await db.run(sql("UPDATE cli_authorizations SET status = 'consumed', used_at = ? WHERE code_hash = ? AND status = 'approved'", at, hash))
      if (claimed.changes !== 1) return null
      return { userId: row.user_id, clientName: row.client_name, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge, scopes: row.scopes }
    },

    attachCliToken: async (code: string, tokenId: string): Promise<void> => {
      await db.run(sql('UPDATE cli_authorizations SET token_id = ? WHERE code_hash = ?', tokenId, await handleHash(code)))
    },

    hitRateLimit: (limit: RateLimit, key: string): Promise<RateDecision> => createRateLimiter(db, now).hit(limit, key),

    purgeExpired: async (graceMs: number = PURGE_GRACE_MS): Promise<PurgeResult> => {
      const before = now() - graceMs
      const [challenges, devices, cliCodes] = await db.batch([
        sql('DELETE FROM login_challenges WHERE expires_at <= ?', before),
        sql('DELETE FROM device_authorizations WHERE expires_at <= ?', before),
        sql('DELETE FROM cli_authorizations WHERE expires_at <= ?', before),
      ])
      const rateLimits = await createRateLimiter(db, now).purge()
      return { challenges: challenges!.changes, devices: devices!.changes, cliCodes: cliCodes!.changes, rateLimits }
    },

    createInvite: async (
      input: { readonly login?: string | null; readonly userId?: string | null; readonly email?: string | null; readonly ttlMs?: number },
      actor: AuditActor,
    ): Promise<CreatedInvite> => {
      const code = generateInviteCode()
      const at = now()
      const expiresAt = at + (input.ttlMs ?? INVITE_TTL_MS)
      const hash = await handleHash(code)
      await db.batch([
        sql(
          'INSERT INTO invites (code_hash, login, user_id, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          hash,
          input.login ?? null,
          input.userId ?? null,
          input.email ?? null,
          actor.kind === 'user' ? actor.id : null,
          at,
          expiresAt,
        ),
        auditStatement(actor, { action: 'invite.create', subjectKind: 'invite', subjectId: hash.slice(0, 16), data: { login: input.login ?? null, userId: input.userId ?? null } }, at),
      ])
      return { code, expiresAt }
    },

    findInvite: async (code: string): Promise<Invite | null> => {
      if (typeof code !== 'string' || !code.startsWith('gfi_') || code.length > 64) return null
      const row = await first<{ login: string | null; user_id: string | null; email: string | null; expires_at: number }>(
        db,
        sql('SELECT login, user_id, email, expires_at FROM invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', await handleHash(code), now()),
      )
      return row ? { login: row.login, userId: row.user_id, email: row.email, expiresAt: row.expires_at } : null
    },

    redeemInvite: async (code: string, userId: string): Promise<boolean> => {
      const at = now()
      const hash = await handleHash(code)
      const result = await db.run(sql('UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', at, userId, hash, at))
      if (result.changes !== 1) return false
      await db.run(auditStatement(userActor(userId), { action: 'invite.redeem', subjectKind: 'invite', subjectId: hash.slice(0, 16) }, at))
      return true
    },

    touchExternalIdentity: async (issuer: string, subject: string): Promise<void> => {
      await db.run(sql('UPDATE external_identities SET last_login_at = ? WHERE issuer = ? AND subject = ?', now(), issuer, subject))
    },
  }
}

export type LoginStore = ReturnType<typeof createLoginStore>
