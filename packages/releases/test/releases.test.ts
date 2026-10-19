import { createHash } from 'node:crypto'
import { type AccountsStore, applyMigrations, createAccountsStore, type Database, MIGRATIONS, sql } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import {
  concat,
  createRepository,
  hashObject,
  lfsObjectKey,
  MemoryStorage,
  ObjectDatabase,
  type PushOutcome,
  readAll,
  readRefs,
  type RepositoryName,
  utf8,
  writePack,
  writeRefs,
} from '@git-forge/core'
import type { ForgeEvent } from '@git-forge/notifications'
import { beforeEach, describe, expect, it } from 'vitest'
import { isValidTagName } from '../src/git.ts'
import { handleReleasesRequest, normalizeAssetName } from '../src/http.ts'

const BASE = 'https://forge.example.org'
const repo: RepositoryName = { owner: 'alice', name: 'engine' }

const commitTo = async (storage: MemoryStorage, branch: string, message: string): Promise<string> => {
  const blob = utf8(message)
  const blobId = hashObject('blob', blob)
  const tree = concat([utf8('100644 README\0'), Uint8Array.from(Buffer.from(blobId, 'hex'))])
  const treeId = hashObject('tree', tree)
  const commit = utf8(`tree ${treeId}\nauthor A <a@example.org> 1760781600 +0000\ncommitter A <a@example.org> 1760781600 +0000\n\n${message}\n`)
  const commitId = hashObject('commit', commit)
  const pack = writePack([
    { type: 'blob', data: blob },
    { type: 'tree', data: tree },
    { type: 'commit', data: commit },
  ])
  await new ObjectDatabase(storage, repo).ingest(new Blob([new Uint8Array(pack.bytes)]).stream())
  const refs = (await readRefs(storage, repo))!
  await writeRefs(storage, repo, { ...refs.state, refs: { ...refs.state.refs, [`refs/heads/${branch}`]: commitId } }, refs.etag)
  return commitId
}

type Fixture = {
  db: Database
  repositoryId: string
  ids: Record<string, string>
  storage: MemoryStorage
  store: AccountsStore
  tokens: Record<'alice' | 'bob' | 'carol', string>
  events: ForgeEvent[]
  tags: PushOutcome[]
  main: string
  call: (method: string, path: string, token: string | null, body?: unknown, headers?: Record<string, string>) => Promise<Response>
}

const setup = async (visibility: 'public' | 'private' = 'private'): Promise<Fixture> => {
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const store = createAccountsStore(db)
  const storage = new MemoryStorage()
  const tokens = {} as Fixture['tokens']
  const ids: Record<string, string> = {}
  for (const login of ['alice', 'bob', 'carol'] as const) {
    ids[login] = (await store.createUser({ login })).id
    tokens[login] = (await store.createPersonalAccessToken(ids[login]!, { name: 't', scopes: ['repo:write'], expiresAt: null })).token
  }
  const repository = await store.createRepository({ ownerId: ids.alice!, name: 'engine', visibility })
  await store.setCollaborator(repository.id, ids.bob!, 'read')
  await createRepository(storage, repo)
  const main = await commitTo(storage, 'main', 'first')
  const events: ForgeEvent[] = []
  const tags: PushOutcome[] = []
  const call = async (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit & { duplex?: string } = {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    }
    if (body instanceof Uint8Array) {
      init.body = new ReadableStream({
        start(controller) {
          controller.enqueue(body)
          controller.close()
        },
      })
      init.duplex = 'half'
    } else if (body !== undefined) {
      init.body = JSON.stringify(body)
      ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
    }
    const response = await handleReleasesRequest(new Request(`${BASE}${path}`, init), {
      db,
      storage,
      directory: store,
      authenticate: async (request) => {
        const header = request.headers.get('Authorization')
        return header ? store.authenticateToken(header.slice(7)) : { kind: 'anonymous' }
      },
      isInstanceAdmin: store.isInstanceAdmin,
      baseUrl: () => BASE,
      maxAssetBytes: 1024 * 1024,
      emit: async (event) => void events.push(event),
      onTagCreated: async (_repo, outcome) => void tags.push(outcome),
    })
    if (!response) throw new Error(`no route for ${method} ${path}`)
    return response
  }
  return { db, repositoryId: repository.id, ids, storage, store, tokens, events, tags, main, call }
}

type Release = { id: number; tag_name: string; draft: boolean; prerelease: boolean; name: string | null; upload_url: string; html_url: string; assets: Asset[]; author: { login: string } }
type Asset = { id: number; name: string; size: number; digest: string; browser_download_url: string; url: string; content_type: string; label: string | null; download_count: number }

describe('release helpers', () => {
  it('validates tag names like git check-ref-format', () => {
    for (const name of ['v1.0.0', 'release/2026-10', 'v1+build']) expect(isValidTagName(name)).toBe(true)
    for (const name of ['', '-v1', 'a..b', 'v1.lock', 'a b', 'a~1', 'x/', '.hidden', 'a@{1}', 'a:b']) expect(isValidTagName(name)).toBe(false)
  })

  it('normalizes asset names', () => {
    expect(normalizeAssetName('my tool (linux).tar.gz')).toBe('my.tool.linux.tar.gz')
    expect(normalizeAssetName('../../etc/passwd')).toBe('etc.passwd')
  })
})

describe('releases API', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await setup()
  })

  it('creates a release and its tag at the default branch, GitHub-shaped', async () => {
    const response = await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v1.0.0', name: 'One', body: 'Notes' })
    expect(response.status).toBe(201)
    const release = (await response.json()) as Release
    expect(release).toMatchObject({
      tag_name: 'v1.0.0',
      name: 'One',
      draft: false,
      prerelease: false,
      author: { login: 'alice' },
      upload_url: `${BASE}/api/uploads/repos/alice/engine/releases/${release.id}/assets{?name,label}`,
      html_url: `${BASE}/alice/engine/releases/tag/v1.0.0`,
      assets: [],
    })
    expect((await readRefs(fixture.storage, repo))!.state.refs['refs/tags/v1.0.0']).toBe(fixture.main)
    expect(fixture.tags[0]!.results).toEqual([{ name: 'refs/tags/v1.0.0', oldId: '0'.repeat(40), newId: fixture.main, ok: true }])
    expect(fixture.events.map((event) => [event.name, event.action])).toEqual([
      ['release', 'created'],
      ['release', 'published'],
      ['release', 'released'],
    ])
    expect((await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v1.0.0' })).status).toBe(422)
    expect((await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v2', target_commitish: 'nope' })).status).toBe(422)
    expect((await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'bad tag' })).status).toBe(422)
  })

  it('tags another branch or commit and leaves existing tags alone', async () => {
    const feature = await commitTo(fixture.storage, 'feature', 'second')
    await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v2', target_commitish: 'feature' })
    await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v3', target_commitish: fixture.main })
    const refs = (await readRefs(fixture.storage, repo))!.state.refs
    expect([refs['refs/tags/v2'], refs['refs/tags/v3']]).toEqual([feature, fixture.main])
    const again = await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v2-notes', target_commitish: 'main' })
    expect(again.status).toBe(201)
    expect(fixture.tags).toHaveLength(3)
  })

  it('keeps drafts private to writers and publishes them later', async () => {
    const draft = (await (await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v2', draft: true })).json()) as Release
    expect((await readRefs(fixture.storage, repo))!.state.refs['refs/tags/v2']).toBeUndefined()
    expect(await (await fixture.call('GET', '/api/v3/repos/alice/engine/releases', fixture.tokens.bob)).json()).toEqual([])
    expect((await fixture.call('GET', `/api/v3/repos/alice/engine/releases/${draft.id}`, fixture.tokens.bob)).status).toBe(404)
    expect((await fixture.call('PATCH', `/api/v3/repos/alice/engine/releases/${draft.id}`, fixture.tokens.bob, { draft: false })).status).toBe(403)
    expect((await fixture.call('GET', '/api/v3/repos/alice/engine/releases', fixture.tokens.carol)).status).toBe(404)
    expect((await fixture.call('GET', '/api/v3/repos/alice/engine/releases', null)).status).toBe(401)
    const published = await fixture.call('PATCH', `/api/v3/repos/alice/engine/releases/${draft.id}`, fixture.tokens.alice, { draft: false, prerelease: true, body: 'beta' })
    expect(await published.json()).toMatchObject({ draft: false, prerelease: true, body: 'beta' })
    expect((await readRefs(fixture.storage, repo))!.state.refs['refs/tags/v2']).toBe(fixture.main)
    expect(fixture.events.map((event) => event.action)).toEqual(['created', 'published', 'prereleased'])
    expect(((await (await fixture.call('GET', '/api/v3/repos/alice/engine/releases', fixture.tokens.bob)).json()) as Release[]).map((release) => release.tag_name)).toEqual(['v2'])
    expect((await fixture.call('GET', '/api/v3/repos/alice/engine/releases/latest', fixture.tokens.bob)).status).toBe(404)
    await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v1' })
    expect(((await (await fixture.call('GET', '/api/v3/repos/alice/engine/releases/latest', fixture.tokens.bob)).json()) as Release).tag_name).toBe('v1')
    expect(((await (await fixture.call('GET', '/api/v3/repos/alice/engine/releases/tags/v2', fixture.tokens.bob)).json()) as Release).id).toBe(draft.id)
    expect((await fixture.call('DELETE', `/api/v3/repos/alice/engine/releases/${draft.id}`, fixture.tokens.alice)).status).toBe(204)
    expect((await fixture.call('GET', '/api/v3/repos/alice/engine/releases/tags/v2', fixture.tokens.bob)).status).toBe(404)
    expect(fixture.events.at(-1)!.action).toBe('deleted')
  })

  it('honors make_latest', async () => {
    const latest = async () => ((await (await fixture.call('GET', '/api/v3/repos/alice/engine/releases/latest', fixture.tokens.bob)).json()) as Release).tag_name
    await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v1' })
    const second = (await (await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v2', make_latest: 'false' })).json()) as Release
    expect(await latest()).toBe('v1')
    await fixture.call('PATCH', `/api/v3/repos/alice/engine/releases/${second.id}`, fixture.tokens.alice, { make_latest: 'true' })
    expect(await latest()).toBe('v2')
    await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v3', make_latest: 'legacy' })
    expect(await latest()).toBe('v2')
    expect((await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v4', make_latest: 'yes' })).status).toBe(422)
  })

  it('stores uploaded assets as LFS objects and redirects downloads to the immutable media URL', async () => {
    const release = (await (await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v1' })).json()) as Release
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 7) % 251)
    const oid = createHash('sha256').update(bytes).digest('hex')
    const upload = await fixture.call('POST', `/api/uploads/repos/alice/engine/releases/${release.id}/assets?name=tool%20linux.tar.gz&label=Linux`, fixture.tokens.alice, bytes, {
      'Content-Type': 'application/gzip',
      'Content-Length': String(bytes.length),
    })
    expect(upload.status).toBe(201)
    const asset = (await upload.json()) as Asset
    expect(asset).toMatchObject({
      name: 'tool.linux.tar.gz',
      label: 'Linux',
      size: bytes.length,
      content_type: 'application/gzip',
      digest: `sha256:${oid}`,
      browser_download_url: `${BASE}/alice/engine/releases/download/v1/tool.linux.tar.gz`,
    })
    const stored = await fixture.storage.get(lfsObjectKey(repo, oid))
    expect(await readAll(stored!.body)).toEqual(bytes)
    const download = await fixture.call('GET', '/alice/engine/releases/download/v1/tool.linux.tar.gz', fixture.tokens.bob)
    expect(download.status).toBe(302)
    expect(download.headers.get('Location')).toBe(`/alice/engine/media/${oid}/tool.linux.tar.gz`)
    expect(download.headers.get('Cache-Control')).toBe('private, no-store')
    const api = await fixture.call('GET', `/api/v3/repos/alice/engine/releases/assets/${asset.id}`, fixture.tokens.bob, undefined, { Accept: 'application/octet-stream' })
    expect(api.headers.get('Location')).toBe(`/alice/engine/media/${oid}/tool.linux.tar.gz`)
    const listed = (await (await fixture.call('GET', `/api/v3/repos/alice/engine/releases/${release.id}/assets`, fixture.tokens.bob)).json()) as Asset[]
    expect(listed[0]!.download_count).toBe(2)
    expect((await fixture.call('POST', `/api/uploads/repos/alice/engine/releases/${release.id}/assets?name=tool%20linux.tar.gz`, fixture.tokens.alice, bytes, { 'Content-Length': String(bytes.length) })).status).toBe(422)
    expect((await fixture.call('POST', `/api/uploads/repos/alice/engine/releases/${release.id}/assets?name=x`, fixture.tokens.bob, bytes, { 'Content-Length': String(bytes.length) })).status).toBe(403)
    const renamed = await fixture.call('PATCH', `/api/v3/repos/alice/engine/releases/assets/${asset.id}`, fixture.tokens.alice, { name: 'tool.tgz', label: null })
    expect(await renamed.json()).toMatchObject({ name: 'tool.tgz', label: null })
    expect((await fixture.call('DELETE', `/api/v3/repos/alice/engine/releases/assets/${asset.id}`, fixture.tokens.alice)).status).toBe(204)
    expect((await fixture.call('GET', '/alice/engine/releases/download/v1/tool.tgz', fixture.tokens.bob)).status).toBe(404)
    expect(await fixture.storage.head(lfsObjectKey(repo, oid))).not.toBeNull()
  })

  it('skips the staging copy when the client names the SHA-256 and rejects mismatches', async () => {
    const release = (await (await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v1' })).json()) as Release
    const bytes = utf8('hello release\n')
    const oid = createHash('sha256').update(bytes).digest('hex')
    const wrong = await fixture.call('POST', `/api/v3/repos/alice/engine/releases/${release.id}/assets?name=a.txt`, fixture.tokens.alice, bytes, {
      'Content-Length': String(bytes.length),
      'X-Content-SHA256': 'f'.repeat(64),
    })
    expect(wrong.status).toBe(422)
    const right = await fixture.call('POST', `/api/v3/repos/alice/engine/releases/${release.id}/assets?name=a.txt`, fixture.tokens.alice, bytes, {
      'Content-Length': String(bytes.length),
      'X-Content-SHA256': oid,
    })
    expect(right.status).toBe(201)
    const staged: string[] = []
    for await (const info of fixture.storage.list('tmp/')) staged.push(info.key)
    expect(staged).toEqual([])
    expect((await fixture.call('POST', `/api/v3/repos/alice/engine/releases/${release.id}/assets?name=b.txt`, fixture.tokens.alice, bytes, {})).status).toBe(411)
    expect((await fixture.call('POST', `/api/v3/repos/alice/engine/releases/${release.id}/assets?name=c.txt`, fixture.tokens.alice, bytes, { 'Content-Length': String(2 * 1024 * 1024) })).status).toBe(413)
  })
})

describe('public repositories', () => {
  it('lets anonymous users read published releases and download assets', async () => {
    const fixture = await setup('public')
    const release = (await (await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v1' })).json()) as Release
    const bytes = utf8('binary')
    await fixture.call('POST', `/api/uploads/repos/alice/engine/releases/${release.id}/assets?name=bin`, fixture.tokens.alice, bytes, { 'Content-Length': String(bytes.length) })
    expect(((await (await fixture.call('GET', '/api/v3/repos/alice/engine/releases', null)).json()) as Release[])[0]!.assets[0]!.name).toBe('bin')
    const download = await fixture.call('HEAD', '/alice/engine/releases/download/v1/bin', null)
    expect(download.status).toBe(302)
    expect(download.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect((await fixture.call('POST', '/api/v3/repos/alice/engine/releases', null, { tag_name: 'v2' })).status).toBe(401)
  })
})

const commitChild = async (storage: MemoryStorage, parent: string, message: string, config: string): Promise<string> => {
  const entry = (mode: string, name: string, id: string) => concat([utf8(`${mode} ${name}\0`), Uint8Array.from(Buffer.from(id, 'hex'))])
  const readme = utf8(message)
  const yml = utf8(config)
  const github = entry('100644', 'release.yml', hashObject('blob', yml))
  const tree = concat([entry('40000', '.github', hashObject('tree', github)), entry('100644', 'README', hashObject('blob', readme))])
  const commit = utf8(`tree ${hashObject('tree', tree)}\nparent ${parent}\nauthor A <a@example.org> 1760781600 +0000\ncommitter A <a@example.org> 1760781600 +0000\n\n${message}\n`)
  const pack = writePack([
    { type: 'blob', data: readme },
    { type: 'blob', data: yml },
    { type: 'tree', data: github },
    { type: 'tree', data: tree },
    { type: 'commit', data: commit },
  ])
  await new ObjectDatabase(storage, repo).ingest(new Blob([new Uint8Array(pack.bytes)]).stream())
  const id = hashObject('commit', commit)
  const refs = (await readRefs(storage, repo))!
  await writeRefs(storage, repo, { ...refs.state, refs: { ...refs.state.refs, 'refs/heads/main': id } }, refs.etag)
  return id
}

describe('generated release notes', () => {
  it('lists merged pull requests since the previous release with categories and new contributors', async () => {
    const fixture = await setup()
    const merged = async (number: number, title: string, author: string, sha: string, label?: string) => {
      await fixture.db.run(
        sql(
          "INSERT INTO issues (node_id, repository_id, number, is_pull, title, author_kind, author_id, state, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 'user', ?, 'closed', ?, ?)",
          `PR${number}`,
          fixture.repositoryId,
          number,
          title,
          fixture.ids[author]!,
          number,
          number,
        ),
      )
      await fixture.db.run(
        sql(
          "INSERT INTO pull_requests (issue_id, repository_id, head_ref, base_ref, head_sha, base_sha, merged_at, merge_commit_sha) SELECT id, ?, 'refs/heads/x', 'refs/heads/main', ?, ?, ?, ? FROM issues WHERE node_id = ?",
          fixture.repositoryId,
          sha,
          sha,
          number,
          sha,
          `PR${number}`,
        ),
      )
      if (label) {
        await fixture.db.run(sql("INSERT OR IGNORE INTO labels (node_id, repository_id, name, color, created_at) VALUES (?, ?, ?, 'ededed', 0)", `L${label}`, fixture.repositoryId, label))
        await fixture.db.run(sql('INSERT INTO issue_labels (issue_id, label_id, created_at) SELECT i.id, l.id, 0 FROM issues i, labels l WHERE i.node_id = ? AND l.name = ?', `PR${number}`, label))
      }
    }
    await merged(1, 'One', 'bob', fixture.main)
    expect((await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v1.0.0' })).status).toBe(201)
    const config = 'changelog:\n  exclude:\n    labels: [skip]\n  categories:\n    - title: Features\n      labels: [feature]\n'
    const second = await commitChild(fixture.storage, fixture.main, 'second', config)
    const third = await commitChild(fixture.storage, second, 'third', config)
    await merged(2, 'Two', 'carol', second, 'feature')
    await merged(3, 'Three', 'bob', third)
    await merged(4, 'Four', 'alice', third, 'skip')
    const body = [
      "## What's Changed",
      '### Features',
      `* Two by @carol in ${BASE}/alice/engine/pull/2`,
      '### Other Changes',
      `* Three by @bob in ${BASE}/alice/engine/pull/3`,
      '',
      '## New Contributors',
      `* @carol made their first contribution in ${BASE}/alice/engine/pull/2`,
      '',
      `**Full Changelog**: ${BASE}/alice/engine/compare/v1.0.0...v2.0.0`,
    ].join('\n')
    const notes = await fixture.call('POST', '/api/v3/repos/alice/engine/releases/generate-notes', fixture.tokens.alice, { tag_name: 'v2.0.0' })
    expect(await notes.json()).toEqual({ name: 'v2.0.0', body })
    expect((await fixture.call('POST', '/api/v3/repos/alice/engine/releases/generate-notes', fixture.tokens.bob, { tag_name: 'v2.0.0' })).status).toBe(403)
    const created = (await (await fixture.call('POST', '/api/v3/repos/alice/engine/releases', fixture.tokens.alice, { tag_name: 'v2.0.0', generate_release_notes: true })).json()) as Release & {
      body: string
      tarball_url: string
      zipball_url: string
    }
    expect(created).toMatchObject({ name: 'v2.0.0', body, tarball_url: `${BASE}/api/v3/repos/alice/engine/tarball/v2.0.0`, zipball_url: `${BASE}/api/v3/repos/alice/engine/zipball/v2.0.0` })
    const all = (await (await fixture.call('POST', '/api/v3/repos/alice/engine/releases/generate-notes', fixture.tokens.alice, { tag_name: 'v2.0.0', previous_tag_name: null, configuration_file_path: 'none.yml' })).json()) as { body: string }
    expect(all.body).toContain('* Four by @alice')
  })
})
