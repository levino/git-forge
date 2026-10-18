import { fromUtf8 } from './encoding.ts'

export type CborValue = number | bigint | string | boolean | null | undefined | Uint8Array<ArrayBuffer> | CborValue[] | CborMap

export type CborMap = Map<number | string, CborValue>

export class CborError extends Error {}

export type Decoded = {
  readonly value: CborValue
  readonly end: number
}

const MAX_DEPTH = 16

const readLength = (bytes: Uint8Array, info: number, offset: number): { length: number; next: number } => {
  if (info < 24) return { length: info, next: offset }
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
  if (size === 0) throw new CborError('indefinite lengths are not supported')
  if (offset + size > bytes.length) throw new CborError('truncated CBOR')
  let length = 0
  for (let i = 0; i < size; i++) length = length * 256 + bytes[offset + i]!
  if (!Number.isSafeInteger(length)) throw new CborError('CBOR length too large')
  return { length, next: offset + size }
}

const decodeAt = (bytes: Uint8Array, offset: number, depth: number): Decoded => {
  if (depth > MAX_DEPTH) throw new CborError('CBOR nested too deeply')
  if (offset >= bytes.length) throw new CborError('truncated CBOR')
  const initial = bytes[offset]!
  const major = initial >> 5
  const info = initial & 0x1f
  if (major === 7) {
    if (info === 20) return { value: false, end: offset + 1 }
    if (info === 21) return { value: true, end: offset + 1 }
    if (info === 22) return { value: null, end: offset + 1 }
    if (info === 23) return { value: undefined, end: offset + 1 }
    throw new CborError(`unsupported CBOR simple value ${info}`)
  }
  const { length, next } = readLength(bytes, info, offset + 1)
  switch (major) {
    case 0:
      return { value: length, end: next }
    case 1:
      return { value: -1 - length, end: next }
    case 2:
    case 3: {
      if (next + length > bytes.length) throw new CborError('truncated CBOR')
      const slice = new Uint8Array(bytes.slice(next, next + length))
      if (major === 2) return { value: slice, end: next + length }
      try {
        return { value: fromUtf8(slice), end: next + length }
      } catch {
        throw new CborError('invalid UTF-8 in CBOR text')
      }
    }
    case 4: {
      const items: CborValue[] = []
      let position = next
      for (let i = 0; i < length; i++) {
        const item = decodeAt(bytes, position, depth + 1)
        items.push(item.value)
        position = item.end
      }
      return { value: items, end: position }
    }
    case 5: {
      const map: CborMap = new Map()
      let position = next
      for (let i = 0; i < length; i++) {
        const key = decodeAt(bytes, position, depth + 1)
        if (typeof key.value !== 'number' && typeof key.value !== 'string') throw new CborError('CBOR map keys must be integers or text')
        if (map.has(key.value)) throw new CborError('duplicate CBOR map key')
        const value = decodeAt(bytes, key.end, depth + 1)
        map.set(key.value, value.value)
        position = value.end
      }
      return { value: map, end: position }
    }
    default:
      throw new CborError(`unsupported CBOR major type ${major}`)
  }
}

export const decodeCborPrefix = (bytes: Uint8Array, offset = 0): Decoded => decodeAt(bytes, offset, 0)

export const decodeCbor = (bytes: Uint8Array): CborValue => {
  const { value, end } = decodeAt(bytes, 0, 0)
  if (end !== bytes.length) throw new CborError('trailing bytes after CBOR value')
  return value
}

export const isCborMap = (value: CborValue): value is CborMap => value instanceof Map

export const isBytes = (value: CborValue): value is Uint8Array<ArrayBuffer> => value instanceof Uint8Array
