import { base64UrlDecode, base64UrlEncode, type Database, first, fromUtf8, sha256Hex, sql, utf8 } from '@git-forge/accounts'

export type SecretsKey = {
  readonly id: string
  readonly key: CryptoKey
}

export class SecretsKeyError extends Error {}

const decodeKey = (text: string): Uint8Array<ArrayBuffer> => {
  const trimmed = text.trim()
  try {
    return /^[0-9a-f]{64}$/i.test(trimmed) ? Uint8Array.from(trimmed.match(/../g)!, (pair) => parseInt(pair, 16)) : base64UrlDecode(trimmed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  } catch {
    throw new SecretsKeyError('the secrets key must be 32 bytes, base64 or hex encoded')
  }
}

export const importSecretsKey = async (encoded: string): Promise<SecretsKey> => {
  const raw = decodeKey(encoded)
  if (raw.length !== 32) throw new SecretsKeyError('the secrets key must be 32 bytes, base64 or hex encoded')
  const id = (await sha256Hex(raw)).slice(0, 16)
  return { id, key: await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']) }
}

export type SecretScope = {
  readonly owner: string
  readonly repo: string
  readonly environment: string
}

const contextData = (context: readonly string[]): Uint8Array<ArrayBuffer> => utf8(JSON.stringify(context)) as Uint8Array<ArrayBuffer>

const additionalData = (scope: SecretScope, name: string): Uint8Array<ArrayBuffer> => contextData(['git-forge-actions-secret', scope.owner, scope.repo, scope.environment, name])

export type SealedSecret = {
  readonly keyId: string
  readonly iv: string
  readonly ciphertext: string
}

const seal = async (key: SecretsKey, data: Uint8Array<ArrayBuffer>, value: string): Promise<SealedSecret> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: data }, key.key, utf8(value) as Uint8Array<ArrayBuffer>))
  return { keyId: key.id, iv: base64UrlEncode(iv), ciphertext: base64UrlEncode(ciphertext) }
}

const open = async (key: SecretsKey, data: Uint8Array<ArrayBuffer>, name: string, sealed: SealedSecret): Promise<string> => {
  if (sealed.keyId !== key.id) throw new SecretsKeyError(`secret ${name} was sealed with another key (${sealed.keyId})`)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlDecode(sealed.iv) as Uint8Array<ArrayBuffer>, additionalData: data },
    key.key,
    base64UrlDecode(sealed.ciphertext) as Uint8Array<ArrayBuffer>,
  )
  return fromUtf8(new Uint8Array(plain))
}

export const sealSecret = (key: SecretsKey, scope: SecretScope, name: string, value: string): Promise<SealedSecret> => seal(key, additionalData(scope, name), value)

export const openSecret = (key: SecretsKey, scope: SecretScope, name: string, sealed: SealedSecret): Promise<string> => open(key, additionalData(scope, name), name, sealed)

export const sealValue = (key: SecretsKey, context: readonly string[], value: string): Promise<SealedSecret> => seal(key, contextData(context), value)

export const openValue = (key: SecretsKey, context: readonly string[], sealed: SealedSecret): Promise<string> => open(key, contextData(context), context.join('/'), sealed)

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export const MAX_SECRET_BYTES = 48 * 1024

export class SecretNameError extends Error {}

export const normalizeSecretName = (name: string): string => {
  if (!SECRET_NAME.test(name) || /^GITHUB_/i.test(name) || name.length > 255) {
    throw new SecretNameError('secret names contain only letters, digits and "_", do not start with a digit or GITHUB_')
  }
  return name.toUpperCase()
}

type SecretRow = {
  readonly owner: string
  readonly repo: string
  readonly environment: string
  readonly name: string
  readonly key_id: string
  readonly iv: string
  readonly ciphertext: string
  readonly created_at: number
  readonly updated_at: number
}

export type SecretInfo = {
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
}

export const putSecret = async (db: Database, key: SecretsKey, scope: SecretScope, name: string, value: string, now: number): Promise<'created' | 'updated'> => {
  const normalized = normalizeSecretName(name)
  if (utf8(value).length > MAX_SECRET_BYTES) throw new SecretNameError(`secret values are limited to ${MAX_SECRET_BYTES} bytes`)
  const sealed = await sealSecret(key, scope, normalized, value)
  const existing = await first(db, sql('SELECT name FROM actions_secrets WHERE owner = ? AND repo = ? AND environment = ? AND name = ?', scope.owner, scope.repo, scope.environment, normalized))
  await db.run(
    sql(
      'INSERT INTO actions_secrets (owner, repo, environment, name, key_id, iv, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner, repo, environment, name) DO UPDATE SET key_id = excluded.key_id, iv = excluded.iv, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at',
      scope.owner,
      scope.repo,
      scope.environment,
      normalized,
      sealed.keyId,
      sealed.iv,
      sealed.ciphertext,
      now,
      now,
    ),
  )
  return existing ? 'updated' : 'created'
}

export const deleteSecret = async (db: Database, scope: SecretScope, name: string): Promise<boolean> =>
  (await db.run(sql('DELETE FROM actions_secrets WHERE owner = ? AND repo = ? AND environment = ? AND name = ?', scope.owner, scope.repo, scope.environment, name.toUpperCase()))).changes === 1

export const listSecrets = async (db: Database, scope: SecretScope): Promise<SecretInfo[]> =>
  (await db.all<SecretRow>(sql('SELECT * FROM actions_secrets WHERE owner = ? AND repo = ? AND environment = ? ORDER BY name', scope.owner, scope.repo, scope.environment))).map((row) => ({
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))

export const getSecretInfo = async (db: Database, scope: SecretScope, name: string): Promise<SecretInfo | null> => {
  const row = await first<SecretRow>(db, sql('SELECT * FROM actions_secrets WHERE owner = ? AND repo = ? AND environment = ? AND name = ?', scope.owner, scope.repo, scope.environment, name.toUpperCase()))
  return row ? { name: row.name, createdAt: row.created_at, updatedAt: row.updated_at } : null
}

export const readSecrets = async (db: Database, key: SecretsKey, scope: SecretScope): Promise<Record<string, string>> => {
  const rows = await db.all<SecretRow>(sql('SELECT * FROM actions_secrets WHERE owner = ? AND repo = ? AND environment = ?', scope.owner, scope.repo, scope.environment))
  const values: Record<string, string> = {}
  for (const row of rows) values[row.name] = await openSecret(key, scope, row.name, { keyId: row.key_id, iv: row.iv, ciphertext: row.ciphertext })
  return values
}

export type EnvironmentReviewer = {
  readonly type: 'User'
  readonly login: string
}

export type Environment = {
  readonly id: number
  readonly owner: string
  readonly repo: string
  readonly name: string
  readonly reviewers: readonly EnvironmentReviewer[]
  readonly createdAt: number
  readonly updatedAt: number
}

type EnvironmentRow = {
  readonly id: number
  readonly owner: string
  readonly repo: string
  readonly name: string
  readonly reviewers: string
  readonly created_at: number
  readonly updated_at: number
}

const toEnvironment = (row: EnvironmentRow): Environment => ({
  id: row.id,
  owner: row.owner,
  repo: row.repo,
  name: row.name,
  reviewers: JSON.parse(row.reviewers) as EnvironmentReviewer[],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,254}$/

export const putEnvironment = async (db: Database, owner: string, repo: string, name: string, reviewers: readonly EnvironmentReviewer[], now: number): Promise<Environment> => {
  await db.run(
    sql(
      'INSERT INTO actions_environments (owner, repo, name, reviewers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner, repo, name) DO UPDATE SET reviewers = excluded.reviewers, updated_at = excluded.updated_at',
      owner,
      repo,
      name,
      JSON.stringify(reviewers),
      now,
      now,
    ),
  )
  return (await getEnvironment(db, owner, repo, name))!
}

export const getEnvironment = async (db: Database, owner: string, repo: string, name: string): Promise<Environment | null> => {
  const row = await first<EnvironmentRow>(db, sql('SELECT rowid AS id, * FROM actions_environments WHERE owner = ? AND repo = ? AND lower(name) = lower(?)', owner, repo, name))
  return row ? toEnvironment(row) : null
}

export const listEnvironments = async (db: Database, owner: string, repo: string): Promise<Environment[]> =>
  (await db.all<EnvironmentRow>(sql('SELECT rowid AS id, * FROM actions_environments WHERE owner = ? AND repo = ? ORDER BY name', owner, repo))).map(toEnvironment)

export const deleteEnvironment = async (db: Database, owner: string, repo: string, name: string): Promise<boolean> => {
  const environment = await getEnvironment(db, owner, repo, name)
  if (!environment) return false
  await db.batch([
    sql('DELETE FROM actions_environments WHERE owner = ? AND repo = ? AND name = ?', owner, repo, environment.name),
    sql('DELETE FROM actions_secrets WHERE owner = ? AND repo = ? AND environment = ?', owner, repo, environment.name),
  ])
  return true
}
