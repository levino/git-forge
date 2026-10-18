import { AGENT } from './receive-pack.ts'
import type { ObjectId } from './hash.ts'

export type FetchFunction = (request: Request) => Promise<Response>

export type AuthorizationSupplier = () => Promise<string | undefined>

export type Remote = {
  readonly url: string
  readonly fetch?: FetchFunction
  readonly getAuthorization?: AuthorizationSupplier
}

export type RemoteRef = {
  readonly name: string
  readonly id: ObjectId
  readonly peeled?: ObjectId
}

export type RemoteRefs = {
  readonly head?: string
  readonly refs: readonly RemoteRef[]
}

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export const USER_AGENT = `git/2.0 (${AGENT})`

export const remoteUrl = (base: string, path: string): string => `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`

export type RemoteRequestInit = {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Uint8Array
  readonly authorize?: boolean
}

export const remoteRequest = async (remote: Remote, url: string, init: RemoteRequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  if (!headers.has('User-Agent')) headers.set('User-Agent', USER_AGENT)
  if (init.authorize !== false) {
    const authorization = await remote.getAuthorization?.()
    if (authorization) headers.set('Authorization', authorization)
  }
  const request = new Request(url, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body ? { body: init.body as Uint8Array<ArrayBuffer> } : {}),
  })
  return (remote.fetch ?? globalThis.fetch)(request)
}

export const expectOk = async (response: Response, what: string): Promise<Response> => {
  if (response.ok) return response
  const detail = (await response.text().catch(() => '')).trim().slice(0, 200)
  throw new RemoteError(`${what} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status)
}

export const parseInfoRefs = (text: string): RemoteRef[] => {
  const refs = new Map<string, { id: ObjectId; peeled?: ObjectId }>()
  for (const line of text.split('\n')) {
    const [id, name] = line.split('\t')
    if (!id || !name) continue
    if (name.endsWith('^{}')) {
      const base = refs.get(name.slice(0, -3))
      if (base) base.peeled = id
      continue
    }
    refs.set(name, { id })
  }
  return [...refs].map(([name, value]) => ({ name, ...value }))
}
