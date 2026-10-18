import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

export type FetchHandler = (request: Request) => Promise<Response>

export type NodeHandlerOptions = {
  readonly trustProxy?: boolean
  readonly onError?: (error: unknown, request: Request | undefined) => void
}

export type ServeOptions = NodeHandlerOptions & {
  readonly port?: number
  readonly host?: string
}

export type RunningServer = {
  readonly server: Server
  readonly url: string
  close(): Promise<void>
}

const BODYLESS = new Set(['GET', 'HEAD'])

const first = (value: string | string[] | undefined): string | undefined => {
  const text = Array.isArray(value) ? value[0] : value
  return text?.split(',')[0]?.trim() || undefined
}

export const requestUrl = (incoming: IncomingMessage, trustProxy = false): string => {
  const forwardedProto = trustProxy ? first(incoming.headers['x-forwarded-proto']) : undefined
  const forwardedHost = trustProxy ? first(incoming.headers['x-forwarded-host']) : undefined
  const encrypted = 'encrypted' in incoming.socket && incoming.socket.encrypted === true
  const protocol = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : encrypted ? 'https' : 'http'
  const host = forwardedHost ?? incoming.headers.host ?? `${incoming.socket.localAddress ?? 'localhost'}:${incoming.socket.localPort ?? 80}`
  return new URL(incoming.url ?? '/', `${protocol}://${host}`).toString()
}

export const CLIENT_ADDRESS_HEADER = 'X-Forge-Client-Address'

export const clientAddressOf = (incoming: IncomingMessage, trustProxy = false): string | null => {
  const header = incoming.headers['x-forwarded-for']
  const forwarded = trustProxy ? [header ?? []].flat().join(',').split(',').at(-1)?.trim() : undefined
  const address = forwarded || incoming.socket.remoteAddress || null
  return address?.replace(/^::ffff:/, '') ?? null
}

export const toRequest = (incoming: IncomingMessage, signal: AbortSignal, trustProxy = false): Request => {
  const headers = new Headers()
  const raw = incoming.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!
    if (name.startsWith(':') || name.toLowerCase() === CLIENT_ADDRESS_HEADER.toLowerCase()) continue
    headers.append(name, raw[i + 1]!)
  }
  const address = clientAddressOf(incoming, trustProxy)
  if (address) headers.set(CLIENT_ADDRESS_HEADER, address)
  const method = incoming.method ?? 'GET'
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal }
  if (!BODYLESS.has(method)) {
    init.body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>
    init.duplex = 'half'
  }
  return new Request(requestUrl(incoming, trustProxy), init)
}

const drained = (outgoing: ServerResponse): Promise<boolean> =>
  new Promise((resolve) => {
    const finish = (value: boolean) => () => {
      outgoing.off('drain', onDrain)
      outgoing.off('close', onClose)
      resolve(value)
    }
    const onDrain = finish(true)
    const onClose = finish(false)
    outgoing.once('drain', onDrain)
    outgoing.once('close', onClose)
  })

export const writeResponse = async (response: Response, outgoing: ServerResponse, method: string): Promise<void> => {
  outgoing.statusCode = response.status
  if (response.statusText) outgoing.statusMessage = response.statusText
  const cookies = response.headers.getSetCookie()
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') outgoing.setHeader(name, value)
  })
  if (cookies.length > 0) outgoing.setHeader('set-cookie', cookies)
  const body = response.body
  if (!body || method === 'HEAD') {
    await body?.cancel().catch(() => undefined)
    outgoing.end()
    return
  }
  const reader = body.getReader()
  const aborted = () => {
    if (!outgoing.writableFinished) void reader.cancel(new Error('client disconnected')).catch(() => undefined)
  }
  outgoing.once('close', aborted)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (outgoing.destroyed) return
      if (!outgoing.write(value) && !(await drained(outgoing))) return
    }
    if (!outgoing.destroyed) outgoing.end()
  } catch (error) {
    outgoing.destroy(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    outgoing.off('close', aborted)
    reader.releaseLock()
  }
}

export const nodeHandler =
  (handler: FetchHandler, options: NodeHandlerOptions = {}) =>
  (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    const controller = new AbortController()
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) controller.abort()
    })
    let request: Request | undefined
    void (async () => {
      try {
        request = toRequest(incoming, controller.signal, options.trustProxy)
        const response = await handler(request)
        await writeResponse(response, outgoing, request.method)
      } catch (error) {
        options.onError?.(error, request)
        if (!outgoing.headersSent) {
          outgoing.statusCode = 500
          outgoing.setHeader('content-type', 'text/plain; charset=utf-8')
          outgoing.end('internal error\n')
        } else if (!outgoing.destroyed) {
          outgoing.destroy()
        }
      }
    })()
  }

export const serve = async (handler: FetchHandler, options: ServeOptions = {}): Promise<RunningServer> => {
  const server = createServer(nodeHandler(handler, options))
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
  return {
    server,
    url: `http://${host === '0.0.0.0' || host === '[::]' ? '127.0.0.1' : host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeIdleConnections()
      }),
  }
}
