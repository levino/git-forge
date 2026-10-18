import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

export type FetchHandler = (request: Request) => Promise<Response>

const toRequest = (incoming: IncomingMessage, base: string): Request => {
  const headers = new Headers()
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else if (value !== undefined) headers.set(key, value)
  }
  const method = incoming.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return new Request(new URL(incoming.url ?? '/', base), {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit)
}

const send = async (response: Response, outgoing: ServerResponse): Promise<void> => {
  outgoing.statusCode = response.status
  response.headers.forEach((value, key) => outgoing.setHeader(key, value))
  if (!response.body) {
    outgoing.end()
    return
  }
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    outgoing.write(value)
  }
  outgoing.end()
}

export type RunningServer = {
  readonly url: string
  readonly requests: { method: string; path: string; status: number }[]
  close(): Promise<void>
}

export const startServer = async (handler: FetchHandler): Promise<RunningServer> => {
  const requests: { method: string; path: string; status: number }[] = []
  let base = ''
  const server: Server = createServer((incoming, outgoing) => {
    const request = toRequest(incoming, base)
    handler(request)
      .then((response) => {
        requests.push({ method: request.method, path: new URL(request.url).pathname + new URL(request.url).search, status: response.status })
        return send(response, outgoing)
      })
      .catch((error: unknown) => {
        requests.push({ method: request.method, path: new URL(request.url).pathname, status: 500 })
        outgoing.statusCode = 500
        outgoing.end(String((error as Error)?.stack ?? error))
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: base,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
