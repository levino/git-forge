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

const CRC_TABLES = (() => {
  const tables = new Uint32Array(8 * 256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    tables[n] = c >>> 0
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[n] as number
    for (let t = 1; t < 8; t++) {
      c = (tables[c & 0xff] as number) ^ (c >>> 8)
      tables[t * 256 + n] = c >>> 0
    }
  }
  return tables
})()

export const crc32 = (data: Uint8Array, previous = 0): number => {
  const t = CRC_TABLES
  let crc = (previous ^ 0xffffffff) | 0
  let i = 0
  const end8 = data.length - (data.length % 8)
  while (i < end8) {
    const a = crc ^ ((data[i] as number) | ((data[i + 1] as number) << 8) | ((data[i + 2] as number) << 16) | ((data[i + 3] as number) << 24))
    crc =
      (t[1792 + (a & 0xff)] as number) ^
      (t[1536 + ((a >>> 8) & 0xff)] as number) ^
      (t[1280 + ((a >>> 16) & 0xff)] as number) ^
      (t[1024 + (a >>> 24)] as number) ^
      (t[768 + (data[i + 4] as number)] as number) ^
      (t[512 + (data[i + 5] as number)] as number) ^
      (t[256 + (data[i + 6] as number)] as number) ^
      (t[data[i + 7] as number] as number)
    i += 8
  }
  while (i < data.length) {
    crc = (t[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8)
    i++
  }
  return (crc ^ 0xffffffff) >>> 0
}

export const hashObject = (type: string, content: Uint8Array): ObjectId => {
  const hash = createSha1()
  hash.update(utf8(`${type} ${content.length}\0`))
  hash.update(content)
  return toHex(hash.digest())
}
