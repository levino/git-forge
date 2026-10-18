import { type CborMap, CborError, decodeCbor, decodeCborPrefix, isBytes, isCborMap } from './cbor.ts'
import { base64UrlDecode, base64UrlEncode, fromUtf8, sha256 } from './encoding.ts'
import { derToRawEcdsa, type VerificationJwk, verifySignature } from './jose.ts'

export const COSE_ALGORITHMS = { ES256: -7, EdDSA: -8, RS256: -257 } as const

export type CoseAlgorithm = (typeof COSE_ALGORITHMS)[keyof typeof COSE_ALGORITHMS]

export const SUPPORTED_COSE_ALGORITHMS: readonly CoseAlgorithm[] = [COSE_ALGORITHMS.ES256, COSE_ALGORITHMS.EdDSA, COSE_ALGORITHMS.RS256]

export const WEBAUTHN_TIMEOUT_MS = 5 * 60 * 1000

export class WebAuthnError extends Error {}

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40
const FLAG_ED = 0x80

export type AuthenticatorData = {
  readonly rpIdHash: Uint8Array<ArrayBuffer>
  readonly flags: number
  readonly userPresent: boolean
  readonly userVerified: boolean
  readonly backupEligible: boolean
  readonly backedUp: boolean
  readonly signCount: number
  readonly attestedCredential: {
    readonly aaguid: string
    readonly credentialId: Uint8Array<ArrayBuffer>
    readonly publicKey: CborMap
  } | null
}

const fail = (message: string): never => {
  throw new WebAuthnError(message)
}

const formatAaguid = (bytes: Uint8Array): string => {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const parseAuthenticatorData = (bytes: Uint8Array): AuthenticatorData => {
  if (bytes.length < 37) fail('authenticator data is too short')
  const flags = bytes[32]!
  const signCount = ((bytes[33]! << 24) >>> 0) + (bytes[34]! << 16) + (bytes[35]! << 8) + bytes[36]!
  let offset = 37
  let attestedCredential: AuthenticatorData['attestedCredential'] = null
  try {
    if (flags & FLAG_AT) {
      if (bytes.length < offset + 18) fail('attested credential data is truncated')
      const aaguid = formatAaguid(bytes.subarray(offset, offset + 16))
      const idLength = (bytes[offset + 16]! << 8) + bytes[offset + 17]!
      offset += 18
      if (idLength === 0 || idLength > 1023 || bytes.length < offset + idLength) fail('invalid credential id length')
      const credentialId = new Uint8Array(bytes.slice(offset, offset + idLength))
      offset += idLength
      const key = decodeCborPrefix(bytes, offset)
      if (!isCborMap(key.value)) fail('credential public key must be a COSE map')
      offset = key.end
      attestedCredential = { aaguid, credentialId, publicKey: key.value as CborMap }
    }
    if (flags & FLAG_ED) offset = decodeCborPrefix(bytes, offset).end
  } catch (error) {
    if (error instanceof CborError) fail(`malformed authenticator data: ${error.message}`)
    throw error
  }
  if (offset !== bytes.length) fail('trailing bytes in authenticator data')
  return {
    rpIdHash: new Uint8Array(bytes.slice(0, 32)),
    flags,
    userPresent: (flags & FLAG_UP) !== 0,
    userVerified: (flags & FLAG_UV) !== 0,
    backupEligible: (flags & FLAG_BE) !== 0,
    backedUp: (flags & FLAG_BS) !== 0,
    signCount,
    attestedCredential,
  }
}

export type CredentialPublicKey = {
  readonly algorithm: CoseAlgorithm
  readonly jwk: VerificationJwk
}

const coseBytes = (key: CborMap, label: number): string => {
  const value = key.get(label)
  if (!isBytes(value ?? null)) fail(`COSE key parameter ${label} is missing`)
  return base64UrlEncode(value as Uint8Array)
}

export const coseKeyToJwk = (key: CborMap): CredentialPublicKey => {
  const kty = key.get(1)
  const alg = key.get(3)
  if (alg === COSE_ALGORITHMS.ES256) {
    if (kty !== 2 || key.get(-1) !== 1) fail('ES256 needs an EC2 key on P-256')
    const x = coseBytes(key, -2)
    const y = coseBytes(key, -3)
    if (base64UrlDecode(x).length !== 32 || base64UrlDecode(y).length !== 32) fail('invalid P-256 coordinates')
    return { algorithm: alg, jwk: { kty: 'EC', crv: 'P-256', x, y, alg: 'ES256' } }
  }
  if (alg === COSE_ALGORITHMS.EdDSA) {
    if (kty !== 1 || key.get(-1) !== 6) fail('EdDSA needs an OKP key on Ed25519')
    const x = coseBytes(key, -2)
    if (base64UrlDecode(x).length !== 32) fail('invalid Ed25519 public key')
    return { algorithm: alg, jwk: { kty: 'OKP', crv: 'Ed25519', x, alg: 'EdDSA' } }
  }
  if (alg === COSE_ALGORITHMS.RS256) {
    if (kty !== 3) fail('RS256 needs an RSA key')
    const n = coseBytes(key, -1)
    if (base64UrlDecode(n).length < 256) fail('RSA keys must have at least 2048 bits')
    return { algorithm: alg, jwk: { kty: 'RSA', n, e: coseBytes(key, -2), alg: 'RS256' } }
  }
  return fail(`unsupported COSE algorithm ${String(alg)}`)
}

export const coseBytesToJwk = (bytes: Uint8Array): CredentialPublicKey => {
  let key
  try {
    key = decodeCbor(bytes)
  } catch (error) {
    if (error instanceof CborError) fail(`malformed COSE key: ${error.message}`)
    throw error
  }
  if (!isCborMap(key ?? null)) fail('COSE key must be a map')
  return coseKeyToJwk(key as CborMap)
}

export type ClientData = {
  readonly type: string
  readonly challenge: string
  readonly origin: string
  readonly crossOrigin: boolean
}

export const parseClientData = (bytes: Uint8Array): ClientData => {
  let value: unknown
  try {
    value = JSON.parse(fromUtf8(bytes))
  } catch {
    return fail('clientDataJSON is not JSON')
  }
  if (typeof value !== 'object' || value === null) fail('clientDataJSON must be an object')
  const data = value as Record<string, unknown>
  if (typeof data.type !== 'string' || typeof data.challenge !== 'string' || typeof data.origin !== 'string') fail('clientDataJSON lacks type, challenge or origin')
  return { type: data.type as string, challenge: data.challenge as string, origin: data.origin as string, crossOrigin: data.crossOrigin === true }
}

export type RelyingParty = {
  readonly id: string
  readonly name: string
  readonly origins: readonly string[]
}

export type CreationOptionsInput = {
  readonly rp: RelyingParty
  readonly user: { readonly handle: Uint8Array; readonly name: string; readonly displayName: string }
  readonly challenge: Uint8Array
  readonly excludeCredentials?: readonly string[]
}

export const creationOptions = (input: CreationOptionsInput) => ({
  rp: { id: input.rp.id, name: input.rp.name },
  user: { id: base64UrlEncode(input.user.handle), name: input.user.name, displayName: input.user.displayName },
  challenge: base64UrlEncode(input.challenge),
  pubKeyCredParams: SUPPORTED_COSE_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
  timeout: WEBAUTHN_TIMEOUT_MS,
  attestation: 'none',
  authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  excludeCredentials: (input.excludeCredentials ?? []).map((id) => ({ type: 'public-key', id })),
})

export const requestOptions = (input: { readonly rp: RelyingParty; readonly challenge: Uint8Array; readonly allowCredentials?: readonly string[] }) => ({
  rpId: input.rp.id,
  challenge: base64UrlEncode(input.challenge),
  timeout: WEBAUTHN_TIMEOUT_MS,
  userVerification: 'required',
  allowCredentials: (input.allowCredentials ?? []).map((id) => ({ type: 'public-key', id })),
})

const field = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} is missing`)
  return value as string
}

const decodeField = (value: unknown, name: string): Uint8Array<ArrayBuffer> => {
  try {
    return base64UrlDecode(field(value, name))
  } catch (error) {
    if (error instanceof WebAuthnError) throw error
    return fail(`${name} is not base64url`)
  }
}

const responseOf = (credential: unknown): Record<string, unknown> => {
  if (typeof credential !== 'object' || credential === null) fail('credential must be an object')
  const value = credential as Record<string, unknown>
  if (value.type !== undefined && value.type !== 'public-key') fail('credential type must be public-key')
  if (typeof value.response !== 'object' || value.response === null) fail('credential response is missing')
  return value.response as Record<string, unknown>
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index])

type Expectations = {
  readonly challenge: string
  readonly rp: RelyingParty
  readonly requireUserVerification?: boolean
}

const checkClientData = (clientData: ClientData, type: string, expected: Expectations): void => {
  if (clientData.type !== type) fail(`clientDataJSON type must be ${type}`)
  if (clientData.challenge !== expected.challenge) fail('challenge does not match')
  if (!expected.rp.origins.includes(clientData.origin)) fail(`unexpected origin ${clientData.origin}`)
  if (clientData.crossOrigin) fail('cross-origin ceremonies are not allowed')
}

const checkAuthenticatorData = async (data: AuthenticatorData, expected: Expectations): Promise<void> => {
  if (!equalBytes(data.rpIdHash, await sha256(expected.rp.id))) fail('authenticator data is for a different relying party')
  if (!data.userPresent) fail('user presence is required')
  if ((expected.requireUserVerification ?? true) && !data.userVerified) fail('user verification is required')
}

export type RegistrationInput = Expectations & { readonly credential: unknown }

export type VerifiedRegistration = {
  readonly credentialId: string
  readonly publicKey: CredentialPublicKey
  readonly signCount: number
  readonly aaguid: string
  readonly format: string
  readonly userVerified: boolean
  readonly backupEligible: boolean
  readonly backedUp: boolean
  readonly transports: readonly string[]
}

export const verifyRegistration = async (input: RegistrationInput): Promise<VerifiedRegistration> => {
  const response = responseOf(input.credential)
  const credential = input.credential as Record<string, unknown>
  const clientDataBytes = decodeField(response.clientDataJSON, 'clientDataJSON')
  checkClientData(parseClientData(clientDataBytes), 'webauthn.create', input)
  let attestation
  try {
    attestation = decodeCbor(decodeField(response.attestationObject, 'attestationObject'))
  } catch (error) {
    if (error instanceof CborError) fail(`malformed attestationObject: ${error.message}`)
    throw error
  }
  if (!isCborMap(attestation ?? null)) fail('attestationObject must be a map')
  const map = attestation as CborMap
  const format = map.get('fmt')
  const authDataBytes = map.get('authData')
  if (typeof format !== 'string' || !isBytes(authDataBytes ?? null) || !isCborMap(map.get('attStmt') ?? null)) fail('attestationObject lacks fmt, attStmt or authData')
  const authData = parseAuthenticatorData(authDataBytes as Uint8Array)
  await checkAuthenticatorData(authData, input)
  const attested = authData.attestedCredential ?? fail('authenticator data carries no credential')
  const credentialId = base64UrlEncode(attested.credentialId)
  const rawId = credential.rawId ?? credential.id
  if (rawId !== undefined && field(rawId, 'rawId') !== credentialId) fail('rawId does not match the attested credential')
  const transports = Array.isArray(response.transports) ? response.transports.filter((item): item is string => typeof item === 'string') : []
  return {
    credentialId,
    publicKey: coseKeyToJwk(attested.publicKey),
    signCount: authData.signCount,
    aaguid: attested.aaguid,
    format: format as string,
    userVerified: authData.userVerified,
    backupEligible: authData.backupEligible,
    backedUp: authData.backedUp,
    transports,
  }
}

export type AssertionCredential = {
  readonly credentialId: string
  readonly userHandle: string | null
}

export const assertionCredential = (credential: unknown): AssertionCredential => {
  const response = responseOf(credential)
  const value = credential as Record<string, unknown>
  const id = field(value.rawId ?? value.id, 'credential id')
  const userHandle = typeof response.userHandle === 'string' && response.userHandle !== '' ? response.userHandle : null
  return { credentialId: id, userHandle }
}

export type AuthenticationInput = Expectations & {
  readonly credential: unknown
  readonly publicKey: CredentialPublicKey
  readonly storedSignCount: number
}

export type VerifiedAuthentication = {
  readonly credentialId: string
  readonly signCount: number
  readonly userVerified: boolean
  readonly backedUp: boolean
}

export const verifyAuthentication = async (input: AuthenticationInput): Promise<VerifiedAuthentication> => {
  const response = responseOf(input.credential)
  const { credentialId } = assertionCredential(input.credential)
  const clientDataBytes = decodeField(response.clientDataJSON, 'clientDataJSON')
  checkClientData(parseClientData(clientDataBytes), 'webauthn.get', input)
  const authDataBytes = decodeField(response.authenticatorData, 'authenticatorData')
  const authData = parseAuthenticatorData(authDataBytes)
  await checkAuthenticatorData(authData, input)
  const signed = new Uint8Array(authDataBytes.length + 32)
  signed.set(authDataBytes)
  signed.set(await sha256(clientDataBytes), authDataBytes.length)
  let signature = decodeField(response.signature, 'signature')
  if (input.publicKey.algorithm === COSE_ALGORITHMS.ES256) {
    try {
      signature = derToRawEcdsa(signature)
    } catch {
      fail('malformed ECDSA signature')
    }
  }
  if (!(await verifySignature(input.publicKey.jwk, signature, signed))) fail('signature does not verify')
  if ((authData.signCount !== 0 || input.storedSignCount !== 0) && authData.signCount <= input.storedSignCount) {
    fail('signature counter did not increase; the authenticator may be cloned')
  }
  return { credentialId, signCount: authData.signCount, userVerified: authData.userVerified, backedUp: authData.backedUp }
}
