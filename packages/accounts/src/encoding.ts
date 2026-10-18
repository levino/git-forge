const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text) as Uint8Array<ArrayBuffer>

export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes)

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

export const sha256 = async (input: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', typeof input === 'string' ? utf8(input) : input))

export const sha256Hex = async (input: string | Uint8Array<ArrayBuffer>): Promise<string> => toHex(await sha256(input))

export const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const BASE64URL = /^[A-Za-z0-9_-]*$/

export const base64UrlDecode = (text: string): Uint8Array<ArrayBuffer> => {
  if (!BASE64URL.test(text) || text.length % 4 === 1) throw new SyntaxError('invalid base64url')
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export const randomBytes = (length: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(length))

export const randomId = (): string => crypto.randomUUID()
