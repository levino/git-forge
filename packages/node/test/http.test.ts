import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { type FetchHandler, type RunningServer, serve } from '../src/http.ts'

let running: RunningServer | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

const start = async (handler: FetchHandler, trustProxy = false): Promise<string> => {
  running = await serve(handler, { trustProxy })
  return running.url
}

const chunks = (count: number, size: number, onPull?: (index: number) => void): ReadableStream<Uint8Array> => {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.(index)
      if (index === count) return controller.close()
      controller.enqueue(new Uint8Array(size).fill(index++ % 256))
    },
  })
}

describe('serve', () => {
  it('streams request bodies into the handler and response bodies back', async () => {
    const url = await start(async (request) => {
      let total = 0
      const reader = request.body!.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
      }
      return new Response(chunks(64, 64 * 1024), { headers: { 'X-Received': String(total) } })
    })
    const response = await fetch(`${url}/upload`, { method: 'POST', body: chunks(32, 32 * 1024), duplex: 'half' } as RequestInit)
    expect(response.headers.get('x-received')).toBe(String(32 * 32 * 1024))
    expect((await response.arrayBuffer()).byteLength).toBe(64 * 64 * 1024)
  })

  it('passes method, path, query and repeated headers, and returns status and cookies', async () => {
    const url = await start(async (request) =>
      Response.json(
        { method: request.method, url: request.url, accept: request.headers.get('accept'), body: request.body === null },
        { status: 201, headers: [['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2'], ['X-Multi', 'one']] },
      ),
    )
    const response = await fetch(`${url}/a/b.git/info/refs?service=git-upload-pack`, { headers: [['Accept', 'x'], ['Accept', 'y']] })
    expect(response.status).toBe(201)
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    expect(await response.json()).toEqual({ method: 'GET', url: `${url}/a/b.git/info/refs?service=git-upload-pack`, accept: 'x, y', body: true })
  })

  it('answers HEAD without a body', async () => {
    const url = await start(async () => new Response('hello', { headers: { 'Content-Length': '5' } }))
    const response = await fetch(url, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('5')
    expect(await response.text()).toBe('')
  })

  it('turns handler errors into 500 and reports them', async () => {
    const errors: unknown[] = []
    running = await serve(
      async () => {
        throw new Error('boom')
      },
      { onError: (error) => errors.push(error) },
    )
    const response = await fetch(running.url)
    expect(response.status).toBe(500)
    expect(errors).toEqual([new Error('boom')])
  })

  it('derives the request origin from forwarded headers only when trusted', async () => {
    const handler: FetchHandler = async (request) => new Response(request.url)
    const forwarded = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'forge.example' }
    const plain = await start(handler)
    expect(await (await fetch(`${plain}/x`, { headers: forwarded })).text()).toBe(`${plain}/x`)
    await running!.close()
    const trusting = await start(handler, true)
    expect(await (await fetch(`${trusting}/x`, { headers: forwarded })).text()).toBe('https://forge.example/x')
  })

  it('cancels the response stream when the client goes away', async () => {
    let cancelled: (reason: unknown) => void = () => undefined
    const gone = new Promise((resolve) => (cancelled = resolve))
    let pulls = 0
    const url = await start(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls++
              controller.enqueue(new Uint8Array(64 * 1024))
            },
            cancel: (reason) => cancelled(reason),
          }),
        ),
    )
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(url, (incoming) => {
        incoming.once('data', () => {
          outgoing.destroy()
          resolve()
        })
      })
      outgoing.on('error', () => undefined)
      outgoing.once('error', reject)
      outgoing.end()
    })
    await gone
    const after = pulls
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pulls).toBe(after)
  })
})
