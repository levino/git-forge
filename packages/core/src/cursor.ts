import { concat } from './bytes.ts'
import { type InflateSink, Inflater } from './zlib.ts'

const EMPTY = new Uint8Array(0)

export class TruncatedError extends Error {}

export class ByteCursor {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  #buffer: Uint8Array = EMPTY
  #position = 0
  #ended = false
  #consumed = 0
  onConsume: ((bytes: Uint8Array) => void) | null = null
  beforeRead: (() => Promise<void>) | null = null

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader()
  }

  get offset(): number {
    return this.#consumed
  }

  get available(): number {
    return this.#buffer.length - this.#position
  }

  async fill(min: number): Promise<number> {
    while (this.available < min && !this.#ended) {
      if (this.beforeRead) await this.beforeRead()
      const { done, value } = await this.#reader.read()
      if (done) {
        this.#ended = true
        break
      }
      if (value.length === 0) continue
      this.#buffer = this.available === 0 ? value : concat([this.#buffer.subarray(this.#position), value])
      this.#position = 0
    }
    return this.available
  }

  async atEnd(): Promise<boolean> {
    return (await this.fill(1)) === 0
  }

  peek(): Uint8Array {
    return this.#buffer.subarray(this.#position)
  }

  skip(length: number): void {
    if (length > this.available) throw new TruncatedError('skip past buffered data')
    if (length === 0) return
    const bytes = this.#buffer.subarray(this.#position, this.#position + length)
    this.#position += length
    this.#consumed += length
    this.onConsume?.(bytes)
  }

  async read(length: number): Promise<Uint8Array> {
    if ((await this.fill(length)) < length) throw new TruncatedError('unexpected end of stream')
    const bytes = this.#buffer.slice(this.#position, this.#position + length)
    this.skip(length)
    return bytes
  }

  async *take(length: number): AsyncGenerator<Uint8Array> {
    let remaining = length
    while (remaining > 0) {
      if ((await this.fill(1)) === 0) throw new TruncatedError('unexpected end of stream')
      const size = Math.min(remaining, this.available)
      const bytes = this.#buffer.subarray(this.#position, this.#position + size)
      this.skip(size)
      remaining -= size
      yield bytes
    }
  }

  async inflate(size: number, options: { readonly keep?: boolean; readonly sink?: InflateSink; readonly scratch?: Uint8Array } = {}): Promise<Uint8Array | null> {
    const inflater = new Inflater(size, options)
    while (!inflater.finished) {
      if ((await this.fill(1)) === 0) throw new TruncatedError('truncated zlib stream')
      this.skip(inflater.push(this.peek()))
    }
    return options.keep ? inflater.data : null
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined)
  }
}
