import pako from 'pako'
import zlibInflate from 'pako/lib/zlib/inflate.js'
import ZStream from 'pako/lib/zlib/zstream.js'
import { concat } from './bytes.ts'

export type Inflated = {
  readonly data: Uint8Array
  readonly consumed: number
}

const Z_STREAM_END = 1
const Z_BUF_ERROR = -5
const CHUNK = 64 * 1024

export const inflateAt = (bytes: Uint8Array, offset: number): Inflated => {
  const strm = new ZStream()
  if (zlibInflate.inflateInit2(strm, 15) !== 0) throw new Error('zlib init failed')
  strm.input = bytes
  strm.next_in = offset
  strm.avail_in = bytes.length - offset
  const parts: Uint8Array[] = []
  for (;;) {
    strm.output = new Uint8Array(CHUNK)
    strm.next_out = 0
    strm.avail_out = CHUNK
    const status = zlibInflate.inflate(strm, 0)
    if (strm.next_out > 0) parts.push(strm.output.subarray(0, strm.next_out))
    if (status === Z_STREAM_END) break
    if (status < 0 && status !== Z_BUF_ERROR) throw new Error(`zlib error ${status}`)
    if (strm.avail_in === 0 && strm.avail_out > 0) throw new Error('truncated zlib stream')
  }
  const consumed = strm.next_in - offset
  zlibInflate.inflateEnd(strm)
  return { data: parts.length === 1 ? (parts[0] as Uint8Array).slice() : concat(parts), consumed }
}

export const deflate = (data: Uint8Array): Uint8Array => pako.deflate(data)
