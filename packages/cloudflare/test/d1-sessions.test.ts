import { AsyncLocalStorage } from 'node:async_hooks'
import { env } from 'cloudflare:workers'
import { applyMigrations, createStateCache, MIGRATIONS, sql } from '@git-forge/accounts'
import { describe, expect, it } from 'vitest'
import { BOOKMARK_HEADER, type ContextStorage, d1Sessions, requestBookmark, sessionStart, withBookmark } from '../src/d1-sessions.ts'

const DB = (env as unknown as { DB: D1Database }).DB

const contextStorage = <T>(): ContextStorage<T> => new AsyncLocalStorage<T>()

describe('d1Sessions', () => {
  it('runs a request in a session, tracks writes and returns its bookmark', async () => {
    const sessions = d1Sessions(DB, contextStorage())
    await sessions.database.run(sql('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)'))
    const read = await sessions.run(null, () => sessions.database.all(sql('SELECT COUNT(*) AS count FROM items')))
    expect(read).toMatchObject({ wrote: false, bookmark: expect.any(String) })
    const written = await sessions.run(read.bookmark, async () => {
      await sessions.database.run(sql('INSERT INTO items (name) VALUES (?)', 'a'))
      return sessions.database.all<{ name: string }>(sql('SELECT name FROM items'))
    })
    expect(written.value.map((row) => row.name)).toContain('a')
    expect(written.wrote).toBe(true)
    expect(written.bookmark).toMatch(/^[0-9A-Za-z-]+$/)
    const returning = await sessions.run(written.bookmark, () => sessions.database.all(sql('INSERT INTO items (name) VALUES (?) RETURNING id', 'b')))
    expect(returning.wrote).toBe(true)
  })

  it('keeps concurrent requests in their own sessions', async () => {
    const sessions = d1Sessions(DB, contextStorage())
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const writer = sessions.run(null, async () => {
      await gate
      await sessions.database.run(sql('CREATE TABLE IF NOT EXISTS concurrent (id INTEGER PRIMARY KEY)'))
    })
    const reader = sessions.run(null, async () => {
      release()
      await writer
      return sessions.database.all(sql('SELECT 1 AS one'))
    })
    expect((await writer).wrote).toBe(true)
    expect((await reader).wrote).toBe(false)
  })

  it('uses the binding without a context and outside a request', async () => {
    const sessions = d1Sessions(DB, null)
    expect(await sessions.run('anything', async () => (await sessions.database.all<{ one: number }>(sql('SELECT 1 AS one')))[0]!.one)).toEqual({ value: 1, bookmark: null, wrote: false })
    expect((await d1Sessions(DB, contextStorage()).database.all<{ one: number }>(sql('SELECT 1 AS one')))[0]!.one).toBe(1)
  })

  it('keeps the state cache on the primary inside a replica session', async () => {
    const sessionQueries: string[] = []
    const spied = new Proxy(DB, {
      get: (target, key) =>
        key === 'withSession'
          ? (start?: string) => {
              const session = target.withSession(start)
              return new Proxy(session, {
                get: (inner, name) => (name === 'prepare' ? (query: string) => (sessionQueries.push(query), inner.prepare(query)) : Reflect.get(inner, name).bind(inner)),
              })
            }
          : Reflect.get(target, key).bind(target),
    })
    const sessions = d1Sessions(spied, contextStorage())
    await applyMigrations(sessions.primary, MIGRATIONS)
    const state = createStateCache(sessions.primary)
    const key = 'repos/a/b/refs.json'
    const { value } = await sessions.run('first-unconstrained', async () => {
      await sessions.database.all(sql('SELECT 1 AS one'))
      await state.fill(key, { etag: 'e1', text: '{}' }, null)
      await state.begin(key, 't')
      await state.commit(key, 't', { etag: 'e2', text: '{}' })
      return (await state.get([key])).get(key)
    })
    expect(value).toMatchObject({ hit: true, value: { etag: 'e2' } })
    expect(sessionQueries).toEqual(['SELECT 1 AS one'])
  })

  it('ignores malformed bookmarks', async () => {
    const sessions = d1Sessions(DB, contextStorage())
    expect((await sessions.run('not a bookmark; Path=/', () => sessions.database.all(sql('SELECT 1 AS one')))).value).toEqual([{ one: 1 }])
  })
})

describe('bookmark transport', () => {
  const outcome = { value: null, bookmark: '00000001-00000002-00000003-abc', wrote: true }

  it('reads the header first, then the cookie', () => {
    expect(requestBookmark(new Request('https://forge.example/', { headers: { [BOOKMARK_HEADER]: 'h', Cookie: '__Host-gf_bookmark=c' } }))).toBe('h')
    expect(requestBookmark(new Request('https://forge.example/', { headers: { Cookie: 'a=b; __Host-gf_bookmark=c' } }))).toBe('c')
    expect(requestBookmark(new Request('http://localhost/', { headers: { Cookie: 'gf_bookmark=d' } }))).toBe('d')
    expect(requestBookmark(new Request('https://forge.example/'))).toBeNull()
    expect(sessionStart(new Request('https://forge.example/', { headers: { Cookie: '__Host-gf_bookmark=c' } }))).toBe('c')
    expect(sessionStart(new Request('https://forge.example/', { method: 'POST', headers: { Cookie: '__Host-gf_bookmark=c' } }))).toBe('first-primary')
  })

  it('sets the cookie after writes of unsafe requests and echoes the header to clients that send one', () => {
    const posted = withBookmark(new Request('https://forge.example/x', { method: 'POST' }), new Response('ok'), outcome)
    expect(posted.headers.get('Set-Cookie')).toBe('__Host-gf_bookmark=00000001-00000002-00000003-abc; Path=/; Max-Age=300; HttpOnly; SameSite=Lax; Secure')
    expect(posted.headers.has(BOOKMARK_HEADER)).toBe(false)
    const fetched = withBookmark(new Request('https://forge.example/x'), new Response('ok'), outcome)
    expect(fetched.headers.has('Set-Cookie')).toBe(false)
    const api = withBookmark(new Request('https://forge.example/api/x', { headers: { [BOOKMARK_HEADER]: 'first-primary' } }), new Response('ok'), { ...outcome, wrote: false })
    expect(api.headers.get(BOOKMARK_HEADER)).toBe(outcome.bookmark)
    expect(api.headers.has('Set-Cookie')).toBe(false)
  })
})
