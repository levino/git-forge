import { base64UrlDecode, base64UrlEncode, sha256, utf8 } from '../../src/index.ts'

type Encodable = number | string | Uint8Array | Encodable[] | Map<number | string, Encodable>

const head = (major: number, length: number): number[] => {
  if (length < 24) return [(major << 5) | length]
  if (length < 0x100) return [(major << 5) | 24, length]
  if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff]
  return [(major << 5) | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]
}

export const encodeCbor = (value: Encodable): Uint8Array => {
  const out: number[] = []
  const write = (item: Encodable): void => {
    if (typeof item === 'number') out.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)))
    else if (typeof item === 'string') {
      const bytes = utf8(item)
      out.push(...head(3, bytes.length), ...bytes)
    } else if (item instanceof Uint8Array) out.push(...head(2, item.length), ...item)
    else if (Array.isArray(item)) {
      out.push(...head(4, item.length))
      for (const entry of item) write(entry)
    } else {
      out.push(...head(5, item.size))
      for (const [key, entry] of item) {
        write(key)
        write(entry)
      }
    }
  }
  write(value)
  return Uint8Array.from(out)
}

export type SoftAuthenticatorOptions = {
  readonly origin: string
  readonly rpId?: string
  readonly userVerified?: boolean
}

export type SoftCredential = {
  readonly id: string
  readonly userHandle: string
  counter: number
}

const rawSignature = async (key: CryptoKey, data: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data))

const toDer = (raw: Uint8Array): Uint8Array<ArrayBuffer> => {
  const integer = (bytes: Uint8Array) => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    const trimmed = bytes.subarray(start)
    const padded = trimmed[0]! & 0x80 ? [0, ...trimmed] : [...trimmed]
    return [0x02, padded.length, ...padded]
  }
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))]
  return Uint8Array.from([0x30, body.length, ...body])
}

export const createSoftAuthenticator = async (options: SoftAuthenticatorOptions) => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const rpId = options.rpId ?? new URL(options.origin).hostname
  const flags = 0x01 | (options.userVerified === false ? 0 : 0x04)
  const credentials = new Map<string, SoftCredential>()

  const authData = async (counter: number, attested: Uint8Array | null) => {
    const bytes = [...(await sha256(rpId)), flags | (attested ? 0x40 : 0), (counter >>> 24) & 0xff, (counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff]
    return Uint8Array.from(attested ? [...bytes, ...attested] : bytes)
  }

  const clientData = (type: string, challenge: string, origin = options.origin) => utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

  return {
    credentials,
    create: async (publicKey: { readonly challenge: string; readonly user: { readonly id: string } }, origin?: string) => {
      const id = crypto.getRandomValues(new Uint8Array(32))
      const cose = encodeCbor(
        new Map<number, Encodable>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, base64UrlDecode(jwk.x!)],
          [-3, base64UrlDecode(jwk.y!)],
        ]),
      )
      const attested = Uint8Array.from([...new Uint8Array(16), id.length >> 8, id.length & 0xff, ...id, ...cose])
      const attestationObject = encodeCbor(
        new Map<string, Encodable>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', await authData(0, attested)],
        ]),
      )
      const credentialId = base64UrlEncode(id)
      credentials.set(credentialId, { id: credentialId, userHandle: publicKey.user.id, counter: 0 })
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: { clientDataJSON: base64UrlEncode(clientData('webauthn.create', publicKey.challenge, origin)), attestationObject: base64UrlEncode(attestationObject), transports: ['internal'] },
      }
    },
    get: async (publicKey: { readonly challenge: string }, credentialId?: string, origin?: string) => {
      const credential = credentialId ? credentials.get(credentialId) : [...credentials.values()][0]
      if (!credential) throw new Error('no credential')
      credential.counter += 1
      const data = await authData(credential.counter, null)
      const client = clientData('webauthn.get', publicKey.challenge, origin)
      const signed = Uint8Array.from([...data, ...(await sha256(client))])
      return {
        id: credential.id,
        rawId: credential.id,
        type: 'public-key',
        response: {
          clientDataJSON: base64UrlEncode(client),
          authenticatorData: base64UrlEncode(data),
          signature: base64UrlEncode(toDer(await rawSignature(pair.privateKey, signed))),
          userHandle: credential.userHandle,
        },
      }
    },
  }
}
