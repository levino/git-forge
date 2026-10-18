const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const utf8 = (text: string): Uint8Array => encoder.encode(text)

export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes)

export const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const byte of bytes) out += HEX[byte]
  return out
}

export const fromHex = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new Error(`invalid hex: ${hex}`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i])

export const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const diff = (a[i] as number) - (b[i] as number)
    if (diff !== 0) return diff
  }
  return a.length - b.length
}

export const readUint32 = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] as number) << 24) |
    ((bytes[offset + 1] as number) << 16) |
    ((bytes[offset + 2] as number) << 8) |
    (bytes[offset + 3] as number)) >>>
  0

export const uint32 = (value: number): Uint8Array =>
  new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])

export const readAll = async (stream: ReadableStream<Uint8Array>, limit = Number.POSITIVE_INFINITY): Promise<Uint8Array> => {
  const parts: Uint8Array[] = []
  let total = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel()
      throw new SizeLimitError(limit)
    }
    parts.push(value)
  }
  return concat(parts)
}

export class SizeLimitError extends Error {
  constructor(readonly limit: number) {
    super(`body exceeds ${limit} bytes`)
  }
}

export const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
