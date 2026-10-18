import { readImportState, readRefs, startImport } from '@git-forge/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T

const basic = (password: string) => `Basic ${btoa(`git:${password}`)}`

const advertise = (forge: NodeForge, repo: string, service: string, authorization?: string) =>
  forge.fetch(new Request(`${BASE}/${repo}.git/info/refs?service=${service}`, { headers: authorization ? { Authorization: authorization } : {} }))

const keys = async (forge: NodeForge, prefix: string): Promise<string[]> => {
  const found: string[] = []
  for await (const info of forge.storage.list(prefix)) found.push(info.key)
  return found
}

describe('repository lifecycle', () => {
  let forge: NodeForge
  let clock = Date.parse('2026-01-01T00:00:00Z')
  let admin: string
  let alice: string
  let bob: string

  beforeAll(async () => {
    forge = await nodeForge({ now: () => new Date(clock) })
    admin = await bootstrap(forge, BASE)
    const token = async (login: string) => {
      await call(forge, BASE, 'POST', '/api/admin/users', admin, { login })
      return (await json<{ token: string }>(await call(forge, BASE, 'POST', `/api/admin/users/${login}/tokens`, admin, { scopes: ['repo:admin'] }))).token
    }
    alice = await token('alice')
    bob = await token('bob')
    expect((await call(forge, BASE, 'POST', '/api/orgs', alice, { login: 'acme' })).status).toBe(201)
    expect((await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'alice', name: 'notes', visibility: 'public' })).status).toBe(201)
    expect((await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'alice', name: 'secret' })).status).toBe(201)
  })

  it('stores description, website and topics with GitHub-compatible fields', async () => {
    const updated = await call(forge, BASE, 'PATCH', '/api/repos/alice/notes', alice, { description: 'Field notes', homepage: 'https://notes.example', topics: ['Git', 'forge', 'git'] })
    expect(await json(updated)).toEqual({ owner: 'alice', name: 'notes', visibility: 'public', description: 'Field notes', homepage: 'https://notes.example', topics: ['git', 'forge'], archived: false })
    expect((await call(forge, BASE, 'PATCH', '/api/repos/alice/notes', alice, { homepage: 'javascript:alert(1)' })).status).toBe(422)
    expect((await call(forge, BASE, 'PATCH', '/api/repos/alice/notes', alice, { topics: ['no spaces'] })).status).toBe(422)
    expect((await call(forge, BASE, 'PATCH', '/api/repos/alice/notes', bob, { description: 'mine' })).status).toBe(403)
    expect(await json(await call(forge, BASE, 'GET', '/api/v3/repos/alice/notes'))).toMatchObject({ description: 'Field notes', homepage: 'https://notes.example', topics: ['git', 'forge'], archived: false, disabled: false })
    expect(await json(await call(forge, BASE, 'PUT', '/api/v3/repos/alice/notes/topics', alice, { names: ['notes'] }))).toEqual({ names: ['notes'] })
    const patched = await call(forge, BASE, 'PATCH', '/api/v3/repos/alice/notes', alice, { description: null })
    expect(patched.status).toBe(200)
    expect(await json(patched)).toMatchObject({ full_name: 'alice/notes', description: null, topics: ['notes'] })
  })

  it('renames in the database only and redirects the old URLs', async () => {
    const renamed = await call(forge, BASE, 'PATCH', '/api/repos/alice/notes', alice, { name: 'journal' })
    expect(await json(renamed)).toMatchObject({ owner: 'alice', name: 'journal' })
    expect(await keys(forge, 'repos/alice/journal/')).toEqual([])
    expect(await keys(forge, 'repos/alice/notes/')).toContain('repos/alice/notes/refs.json')
    expect((await readRefs(forge.services.storage, { owner: 'alice', name: 'journal' }))?.state.head).toBe('refs/heads/main')
    const api = await call(forge, BASE, 'GET', '/api/v3/repos/alice/notes/issues?state=all')
    expect(api.status).toBe(301)
    expect(api.headers.get('Location')).toBe(`${BASE}/api/v3/repos/alice/journal/issues?state=all`)
    expect((await call(forge, BASE, 'POST', '/api/v3/repos/alice/notes/issues', alice, { title: 'x' })).status).toBe(307)
    const git = await advertise(forge, 'alice/notes', 'git-upload-pack')
    expect(git.status).toBe(301)
    expect(git.headers.get('Location')).toBe(`${BASE}/alice/journal.git/info/refs?service=git-upload-pack`)
    expect((await call(forge, BASE, 'PATCH', '/api/repos/alice/secret', alice, { name: 'hidden' })).status).toBe(200)
    expect((await advertise(forge, 'alice/secret', 'git-upload-pack')).status).toBe(401)
    expect((await advertise(forge, 'alice/secret', 'git-upload-pack', basic(bob))).status).toBe(404)
    expect((await advertise(forge, 'alice/secret', 'git-upload-pack', basic(alice))).status).toBe(301)
  })

  it('frees an old name for a new repository with its own storage', async () => {
    expect((await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'alice', name: 'notes' })).status).toBe(409)
    clock += 5 * 60 * 1000
    expect((await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'alice', name: 'notes' })).status).toBe(201)
    expect((await forge.services.store.locateRepository('alice', 'notes'))?.path).toMatch(/^alice\/notes\.[0-9a-f]{8}$/)
    expect((await forge.services.store.locateRepository('alice', 'journal'))?.path).toBe('alice/notes')
    expect((await call(forge, BASE, 'GET', '/api/v3/repos/alice/notes', alice)).status).toBe(200)
  })

  it('keeps an import in progress working across a rename', async () => {
    expect((await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'alice', name: 'incoming' })).status).toBe(201)
    await startImport(forge.services.storage, { owner: 'alice', name: 'incoming' }, { url: 'https://upstream.example/x.git' })
    expect((await call(forge, BASE, 'PATCH', '/api/repos/alice/incoming', alice, { name: 'imported' })).status).toBe(200)
    expect((await readImportState(forge.services.storage, { owner: 'alice', name: 'incoming' }))?.url).toBe('https://upstream.example/x.git')
    expect((await readImportState(forge.services.storage, { owner: 'alice', name: 'imported' }))?.url).toBe('https://upstream.example/x.git')
  })

  it('transfers only to accounts the actor administers', async () => {
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/journal/transfer', alice, { owner: 'bob' })).status).toBe(403)
    expect(await json(await call(forge, BASE, 'POST', '/api/repos/alice/journal/transfer', alice, { owner: 'acme' }))).toMatchObject({ owner: 'acme', name: 'journal' })
    expect((await advertise(forge, 'alice/journal', 'git-upload-pack')).headers.get('Location')).toBe(`${BASE}/acme/journal.git/info/refs?service=git-upload-pack`)
    expect((await advertise(forge, 'alice/notes', 'git-upload-pack', basic(alice))).status).toBe(200)
  })

  it('makes archived repositories read-only', async () => {
    expect(await json(await call(forge, BASE, 'PATCH', '/api/repos/acme/journal', alice, { archived: true }))).toMatchObject({ archived: true })
    const push = await advertise(forge, 'acme/journal', 'git-receive-pack', basic(alice))
    expect(push.status).toBe(403)
    expect(await push.text()).toContain('archived')
    expect((await advertise(forge, 'acme/journal', 'git-receive-pack', basic(admin))).status).toBe(403)
    expect((await advertise(forge, 'acme/journal', 'git-upload-pack')).status).toBe(200)
    expect((await call(forge, BASE, 'POST', '/api/v3/repos/acme/journal/issues', alice, { title: 'x' })).status).toBe(403)
    await call(forge, BASE, 'PATCH', '/api/repos/acme/journal', alice, { archived: false })
    expect((await advertise(forge, 'acme/journal', 'git-receive-pack', basic(alice))).status).toBe(200)
  })

  it('deletes softly and frees the name after the grace period', async () => {
    expect((await call(forge, BASE, 'DELETE', '/api/repos/acme/journal', bob)).status).toBe(403)
    expect((await call(forge, BASE, 'DELETE', '/api/v3/repos/acme/journal', alice)).status).toBe(204)
    expect((await call(forge, BASE, 'GET', '/api/v3/repos/acme/journal', alice)).status).toBe(404)
    expect((await advertise(forge, 'alice/journal', 'git-upload-pack', basic(alice))).status).toBe(404)
    expect(await readRefs(forge.services.storage, { owner: 'alice', name: 'notes' })).not.toBeNull()
    clock += 60 * 1000
    expect(await readRefs(forge.services.storage, { owner: 'acme', name: 'journal' })).toBeNull()
    expect(await keys(forge, 'repos/alice/notes/')).toContain('repos/alice/notes/refs.json')
    expect((await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'acme', name: 'journal' })).status).toBe(409)
    clock += 8 * 24 * 60 * 60 * 1000
    expect((await call(forge, BASE, 'POST', '/api/repos', alice, { owner: 'acme', name: 'journal' })).status).toBe(201)
    expect((await readRefs(forge.services.storage, { owner: 'acme', name: 'journal' }))?.state.refs).toEqual({})
  })

  it('renames accounts and redirects their old login', async () => {
    expect((await call(forge, BASE, 'PATCH', '/api/accounts/alice', bob, { login: 'alicia' })).status).toBe(403)
    expect((await call(forge, BASE, 'PATCH', '/api/accounts/alice', alice, { login: 'api' })).status).toBe(422)
    expect((await call(forge, BASE, 'PATCH', '/api/accounts/alice', alice, { login: 'bob' })).status).toBe(409)
    expect(await json(await call(forge, BASE, 'PATCH', '/api/accounts/alice', alice, { login: 'alicia' }))).toMatchObject({ login: 'alicia' })
    expect((await call(forge, BASE, 'GET', '/api/v3/repos/alice/hidden', alice)).headers.get('Location')).toBe(`${BASE}/api/v3/repos/alicia/hidden`)
    expect((await advertise(forge, 'alicia/hidden', 'git-upload-pack', basic(alice))).status).toBe(200)
    expect((await call(forge, BASE, 'PATCH', '/api/accounts/acme', bob, { login: 'acme-corp' })).status).toBe(403)
    expect((await call(forge, BASE, 'PATCH', '/api/accounts/acme', alice, { login: 'acme-corp' })).status).toBe(200)
    expect((await call(forge, BASE, 'PATCH', '/api/accounts/bob', admin, { login: 'robert' })).status).toBe(200)
    expect(await forge.services.redirect(new Request(`${BASE}/bob`), { kind: 'anonymous' })).toBe(`${BASE}/robert`)
    expect(await json(await call(forge, BASE, 'GET', '/api/user', bob))).toMatchObject({ login: 'robert' })
  })
})
