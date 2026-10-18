import { concat, fromUtf8, toHex, utf8 } from '@git-forge/core'

export type RecoveryPublicKey = {
  readonly kty: 'OKP'
  readonly crv: 'X25519'
  readonly x: string
}

export type RecoveryPrivateKey = RecoveryPublicKey & {
  readonly d: string
}

export class BackupKeyError extends Error {}

const BASE64URL = /^[A-Za-z0-9_-]*$/

export const base64url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const fromBase64url = (text: string): Uint8Array => {
  if (!BASE64URL.test(text) || text.length % 4 === 1) throw new BackupKeyError('invalid base64url')
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const buffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(bytes)))

const parseJson = (text: string | object): Record<string, unknown> => {
  if (typeof text !== 'string') return text as Record<string, unknown>
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  } catch {}
  throw new BackupKeyError('a recovery key must be a JWK')
}

const coordinate = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || fromBase64url(value).length !== 32) throw new BackupKeyError(`recovery key ${name} must be 32 bytes in base64url`)
  return value
}

export const parseRecoveryPublicKey = (input: string | object): RecoveryPublicKey => {
  const jwk = parseJson(input)
  if (jwk.kty !== 'OKP' || jwk.crv !== 'X25519') throw new BackupKeyError('a recovery key must be an X25519 JWK (kty OKP, crv X25519)')
  return { kty: 'OKP', crv: 'X25519', x: coordinate(jwk.x, 'x') }
}

export const parseRecoveryPrivateKey = (input: string | object): RecoveryPrivateKey => {
  const jwk = parseJson(input)
  const pub = parseRecoveryPublicKey(jwk)
  return { ...pub, d: coordinate(jwk.d, 'd') }
}

export const recoveryKeyId = async (key: RecoveryPublicKey): Promise<string> =>
  base64url(await sha256(utf8(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x }))))

export const generateRecoveryKey = async (): Promise<{ readonly privateKey: RecoveryPrivateKey; readonly publicKey: RecoveryPublicKey; readonly id: string }> => {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const privateKey = parseRecoveryPrivateKey(jwk)
  const publicKey = parseRecoveryPublicKey(privateKey)
  return { privateKey, publicKey, id: await recoveryKeyId(publicKey) }
}

const importPublic = (key: RecoveryPublicKey) => crypto.subtle.importKey('jwk', { kty: key.kty, crv: key.crv, x: key.x }, { name: 'X25519' }, true, [])

const importPrivate = (key: RecoveryPrivateKey) =>
  crypto.subtle.importKey('jwk', { kty: key.kty, crv: key.crv, x: key.x, d: key.d }, { name: 'X25519' }, false, ['deriveBits'])

const RUN_INFO = utf8('git-forge backup run v1')

const runKey = async (shared: Uint8Array, ephemeral: Uint8Array, recipient: Uint8Array): Promise<CryptoKey> => {
  const base = await crypto.subtle.importKey('raw', buffer(shared), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buffer(concat([ephemeral, recipient])), info: buffer(RUN_INFO) }, base, 256)
  return crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
}

export type RunKeyRecord = {
  readonly format: 'git-forge-backup-key'
  readonly version: 1
  readonly run: string
  readonly recipient: string
  readonly ephemeral: string
  readonly created: string
}

export type SealedRun = {
  readonly record: RunKeyRecord
  readonly key: CryptoKey
}

export const sealRun = async (recipient: RecoveryPublicKey, run: string, at: Date): Promise<SealedRun> => {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
  const ephemeral = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: await importPublic(recipient) }, pair.privateKey, 256))
  return {
    record: {
      format: 'git-forge-backup-key',
      version: 1,
      run,
      recipient: await recoveryKeyId(recipient),
      ephemeral: base64url(ephemeral),
      created: at.toISOString(),
    },
    key: await runKey(shared, ephemeral, fromBase64url(recipient.x)),
  }
}

export const parseRunKeyRecord = (bytes: Uint8Array): RunKeyRecord => {
  const value = JSON.parse(fromUtf8(bytes)) as RunKeyRecord
  if (value.format !== 'git-forge-backup-key' || value.version !== 1) throw new BackupKeyError('unknown key record format')
  return value
}

export const openRun = async (privateKey: RecoveryPrivateKey, record: RunKeyRecord): Promise<CryptoKey> => {
  if (record.recipient !== (await recoveryKeyId(privateKey))) throw new BackupKeyError(`run ${record.run} is sealed to another recovery key (${record.recipient})`)
  const ephemeral = fromBase64url(record.ephemeral)
  const publicKey = await crypto.subtle.importKey('raw', buffer(ephemeral), { name: 'X25519' }, true, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, await importPrivate(privateKey), 256))
  return runKey(shared, ephemeral, fromBase64url(privateKey.x))
}

const NAMES_INFO = utf8('git-forge backup names v1')

export type NameKey = CryptoKey

export const nameKeyFromSecret = async (secret: string): Promise<NameKey> => {
  if (secret.length < 32) throw new BackupKeyError('the backup secret must have at least 32 characters')
  const base = await crypto.subtle.importKey('raw', buffer(utf8(secret)), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: buffer(NAMES_INFO) }, base, 256)
  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

export const opaqueName = async (key: NameKey, address: string): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer(utf8(address)))))
