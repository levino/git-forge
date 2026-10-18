import type { Readable } from 'node:stream'

export class LineReader {
  readonly #iterator: AsyncIterator<Buffer>
  #buffer: Buffer = Buffer.alloc(0)
  #ended = false

  constructor(stream: Readable) {
    this.#iterator = (stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>)
  }

  async readLine(): Promise<string | null> {
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a)
      if (newline !== -1) {
        const line = this.#buffer.subarray(0, newline).toString('utf8')
        this.#buffer = this.#buffer.subarray(newline + 1)
        return line
      }
      if (this.#ended) {
        if (this.#buffer.length === 0) return null
        const line = this.#buffer.toString('utf8')
        this.#buffer = Buffer.alloc(0)
        return line
      }
      const next = await this.#iterator.next()
      if (next.done) this.#ended = true
      else this.#buffer = Buffer.concat([this.#buffer, next.value])
    }
  }

  async readBlock(): Promise<string[]> {
    const lines: string[] = []
    for (;;) {
      const line = await this.readLine()
      if (line === null || line === '') return lines
      lines.push(line)
    }
  }

  async *rest(): AsyncGenerator<Buffer> {
    if (this.#buffer.length > 0) {
      const pending = this.#buffer
      this.#buffer = Buffer.alloc(0)
      yield pending
    }
    while (!this.#ended) {
      const next = await this.#iterator.next()
      if (next.done) this.#ended = true
      else yield next.value
    }
  }
}
