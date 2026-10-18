import pako from 'pako'
import zlibInflate from 'pako/lib/zlib/inflate.js'
import ZStream from 'pako/lib/zlib/zstream.js'
import { concat } from './bytes.ts'

export type Inflated = {
  readonly data: Uint8Array
  readonly consumed: number
}

const Z_OK = 0
const Z_STREAM_END = 1
const Z_BUF_ERROR = -5
const CHUNK = 64 * 1024

const failed = (status: number): boolean => status !== Z_OK && status !== Z_STREAM_END && status !== Z_BUF_ERROR

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
    if (failed(status)) throw new Error(`zlib error ${status}`)
    if (strm.avail_in === 0 && strm.avail_out > 0) throw new Error('truncated zlib stream')
  }
  const consumed = strm.next_in - offset
  zlibInflate.inflateEnd(strm)
  return { data: parts.length === 1 ? (parts[0] as Uint8Array).slice() : concat(parts), consumed }
}

export class InflateError extends Error {}

export type InflateSink = (chunk: Uint8Array) => void

export class Inflater {
  readonly #strm = new ZStream()
  readonly #scratch: Uint8Array
  readonly #size: number
  readonly #target: Uint8Array | null
  readonly #sink: InflateSink | null
  #produced = 0
  #finished = false

  constructor(size: number, options: { readonly keep?: boolean; readonly sink?: InflateSink; readonly scratch?: Uint8Array } = {}) {
    if (zlibInflate.inflateInit2(this.#strm, 15) !== 0) throw new InflateError('zlib init failed')
    this.#size = size
    this.#target = options.keep ? new Uint8Array(size) : null
    this.#sink = options.sink ?? null
    this.#scratch = options.scratch ?? new Uint8Array(CHUNK)
  }

  get finished(): boolean {
    return this.#finished
  }

  get data(): Uint8Array {
    if (!this.#target || !this.#finished) throw new InflateError('inflated data not kept')
    return this.#target
  }

  push(input: Uint8Array): number {
    const strm = this.#strm
    strm.input = input
    strm.next_in = 0
    strm.avail_in = input.length
    for (;;) {
      const intoTarget = this.#target !== null && this.#produced < this.#size
      const output = intoTarget ? (this.#target as Uint8Array) : this.#scratch
      const start = intoTarget ? this.#produced : 0
      strm.output = output
      strm.next_out = start
      strm.avail_out = intoTarget ? this.#size - this.#produced : output.length
      const status = zlibInflate.inflate(strm, 0)
      const produced = strm.next_out - start
      if (produced > 0) {
        if (!intoTarget && this.#target !== null) throw new InflateError('inflated size mismatch')
        this.#produced += produced
        if (this.#produced > this.#size) throw new InflateError('inflated size mismatch')
        this.#sink?.(output.subarray(start, start + produced))
      }
      if (status === Z_STREAM_END) {
        if (this.#produced !== this.#size) throw new InflateError('inflated size mismatch')
        this.#finished = true
        zlibInflate.inflateEnd(strm)
        return strm.next_in
      }
      if (failed(status)) throw new InflateError(`zlib error ${status}`)
      if (strm.avail_in === 0) return input.length
      if (produced === 0 && strm.avail_out > 0) throw new InflateError('zlib made no progress')
    }
  }
}

export const inflateExact = (bytes: Uint8Array, size: number): Uint8Array => {
  const inflater = new Inflater(size, { keep: true, scratch: new Uint8Array(1024) })
  inflater.push(bytes)
  if (!inflater.finished) throw new InflateError('truncated zlib stream')
  return inflater.data
}

export const deflate = (data: Uint8Array): Uint8Array => pako.deflate(data)
