import { type Database, d1Database } from '@git-forge/accounts'

export type ContextStorage<T> = { run<R>(store: T, callback: () => R): R; getStore(): T | undefined }

export type RequestSession = { readonly session: D1DatabaseSession; wrote: boolean }

export type SessionOutcome<T> = { readonly value: T; readonly bookmark: string | null; readonly wrote: boolean }

export type D1Sessions = {
  readonly database: Database
  readonly primary: Database
  readonly run: <T>(bookmark: string | null, callback: () => Promise<T>) => Promise<SessionOutcome<T>>
}

export const BOOKMARK_HEADER = 'X-Forge-Bookmark'

const BOOKMARK = /^[0-9A-Za-z-]{1,256}$/

const READ = /^\s*(SELECT|WITH)\b/i

export const d1Sessions = (d1: D1Database, context: ContextStorage<RequestSession> | null): D1Sessions => {
  const current = () => context?.getStore()
  const target = () => current()?.session ?? d1
  const inner = d1Database({ prepare: (query) => target().prepare(query), batch: (statements) => target().batch(statements as D1PreparedStatement[]) })
  const wrote = () => {
    const state = current()
    if (state) state.wrote = true
  }
  return {
    database: {
      all: (statement) => (READ.test(statement.sql) ? undefined : wrote(), inner.all(statement)),
      run: (statement) => (wrote(), inner.run(statement)),
      batch: (statements) => (wrote(), inner.batch(statements)),
      read: (statements) => inner.read(statements),
    },
    primary: d1Database(d1),
    run: async (bookmark, callback) => {
      if (!context) return { value: await callback(), bookmark: null, wrote: false }
      const state: RequestSession = { session: d1.withSession(bookmark !== null && BOOKMARK.test(bookmark) ? bookmark : 'first-unconstrained'), wrote: false }
      const value = await context.run(state, callback)
      return { value, bookmark: state.session.getBookmark(), wrote: state.wrote }
    },
  }
}

const cookieName = (secure: boolean) => (secure ? '__Host-gf_bookmark' : 'gf_bookmark')

const isSecure = (request: Request) => new URL(request.url).protocol === 'https:'

export const requestBookmark = (request: Request): string | null => {
  const header = request.headers.get(BOOKMARK_HEADER)
  if (header) return header
  const name = cookieName(isSecure(request))
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return null
}

const isUnsafe = (request: Request) => request.method !== 'GET' && request.method !== 'HEAD'

export const sessionStart = (request: Request): string | null => (isUnsafe(request) ? 'first-primary' : requestBookmark(request))

export const BOOKMARK_COOKIE_SECONDS = 300

export const withBookmark = (request: Request, response: Response, outcome: SessionOutcome<unknown>): Response => {
  if (outcome.bookmark === null || !BOOKMARK.test(outcome.bookmark) || response.webSocket) return response
  const explicit = request.headers.has(BOOKMARK_HEADER)
  const remember = outcome.wrote && isUnsafe(request)
  if (!explicit && !remember) return response
  const secure = isSecure(request)
  const headers = new Headers(response.headers)
  if (explicit) headers.set(BOOKMARK_HEADER, outcome.bookmark)
  if (remember) headers.append('Set-Cookie', `${cookieName(secure)}=${outcome.bookmark}; Path=/; Max-Age=${BOOKMARK_COOKIE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
