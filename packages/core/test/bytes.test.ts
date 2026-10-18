import { describe, expect, it } from 'vitest'
import { concat, exactLength, readAll, utf8 } from '../src/bytes.ts'

const through = (parts: readonly Uint8Array[], size: number) => {
  const received: Uint8Array[] = []
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
  const reader = source.pipeThrough(exactLength(size)).getReader()
  const drain = async (): Promise<Uint8Array> => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return concat(received)
      received.push(value)
    }
  }
  return { drain, received }
}

describe('exactLength', () => {
  it('passes a body of exactly the declared size', async () => {
    const parts = [utf8('ab'), new Uint8Array(0), utf8('c'), utf8('def')]
    expect(await through(parts, 6).drain()).toEqual(utf8('abcdef'))
    expect(await readAll(new ReadableStream<Uint8Array>({ start: (c) => c.close() }).pipeThrough(exactLength(0)))).toEqual(new Uint8Array(0))
  })

  it('withholds the final byte when the body runs long', async () => {
    const run = through([utf8('abc'), utf8('def')], 3)
    await expect(run.drain()).rejects.toThrow(/size mismatch/)
    expect(concat(run.received).length).toBeLessThan(3)
  })

  it('withholds the final byte when the body ends short', async () => {
    const run = through([utf8('ab')], 3)
    await expect(run.drain()).rejects.toThrow(/size mismatch/)
    expect(concat(run.received).length).toBeLessThan(3)
  })
})
