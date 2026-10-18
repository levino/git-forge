import { sha1 as nobleSha1 } from '@noble/hashes/legacy.js'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { toHex, utf8 } from './bytes.ts'

export type ObjectId = string

export const sha1 = (data: Uint8Array): Uint8Array => nobleSha1(data)

export const sha1Hex = (data: Uint8Array): ObjectId => toHex(nobleSha1(data))

export const sha256Hex = (data: Uint8Array): string => toHex(nobleSha256(data))

export const createSha1 = () => nobleSha1.create()

export const createSha256 = () => nobleSha256.create()

export const ZERO_ID: ObjectId = '0'.repeat(40)

export const isObjectId = (value: string): boolean => /^[0-9a-f]{40}$/.test(value)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export const crc32 = (data: Uint8Array, previous = 0): number => {
  let crc = previous ^ 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export const hashObject = (type: string, content: Uint8Array): ObjectId => {
  const hash = createSha1()
  hash.update(utf8(`${type} ${content.length}\0`))
  hash.update(content)
  return toHex(hash.digest())
}
