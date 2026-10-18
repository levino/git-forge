import { readFileSync } from 'node:fs'
import { type ImportJob, type ImportState, lfsObjectKey, ObjectDatabase, readAll, readImportState, readRefs, sha256Hex, streamOf, updateRefs, ZERO_ID } from '@git-forge/core'
import { commitAll, git, gitBytes, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { beforeAll, describe, expect, it } from 'vitest'
import { basicAuthorization } from '../../src/app.ts'
import { type GithubProgress, githubRepository } from '../../src/github-import.ts'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'
const API = 'https://api.github.com'
const ASSET_HOST = 'https://release-assets.githubusercontent.com'
const repo = { owner: 'alice', name: 'site' }
const asset = new TextEncoder().encode('tool binary\n'.repeat(100))

type Recorded = { readonly method: string; readonly url: string; readonly authorization: string | null }

const lines = (count: number, change?: [number, string]) => Array.from({ length: count }, (_, i) => (change && change[0] === i ? change[1] : `line ${i}`)).join('\n') + '\n'

const history = () => {
  const dir = initRepo()
  writeFile(dir, 'README.md', lines(20))
  writeFile(dir, 'src.txt', lines(10))
  const start = commitAll(dir, 'initial')
  git(dir, ['checkout', '-q', '-b', 'feature'])
  writeFile(dir, 'README.md', lines(20, [15, 'line 15 fixed']))
  const feature = commitAll(dir, 'fix line 15')
  git(dir, ['checkout', '-q', 'main'])
  git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #2', 'feature'])
  const main = git(dir, ['rev-parse', 'HEAD']).trim()
  git(dir, ['checkout', '-q', '-b', 'topic'])
  writeFile(dir, 'src.txt', lines(10, [2, 'changed']))
  const topic = commitAll(dir, 'change the source')
  git(dir, ['checkout', '-q', 'main'])
  return { dir, shas: { start, feature, main, topic } }
}

const fakeGithub = (shas: Record<string, string>, etags: { enabled: boolean }) => {
  let text = readFileSync(new URL('../fixtures/github-acme-site.json', import.meta.url), 'utf8')
  for (const [name, sha] of Object.entries(shas)) text = text.replaceAll(`{{${name}}}`, sha)
  text = text.replace('"{{assetSize}}"', String(asset.length)).replace('{{assetSha}}', sha256Hex(asset))
  const fixtures = JSON.parse(text) as Record<string, { headers: Record<string, string>; body: unknown }>
  const requests: Recorded[] = []
  const limited = new Set<string>()
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    requests.push({ method: request.method, url: request.url, authorization: request.headers.get('authorization') })
    if (url.origin === ASSET_HOST) return new Response(asset, { headers: { 'Content-Length': String(asset.length) } })
    const key = `${url.pathname}${url.search}`
    if (key === '/repos/acme/site/releases/assets/501' && request.headers.get('accept') === 'application/octet-stream') {
      return new Response(null, { status: 302, headers: { Location: `${ASSET_HOST}/501?sig=x` } })
    }
    if (key.startsWith('/repos/acme/site/issues/comments') && !limited.has(key)) {
      limited.add(key)
      return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792364306' } })
    }
    const fixture = fixtures[key]
    if (!fixture) return new Response('{"message":"Not Found"}', { status: 404 })
    if (etags.enabled && request.headers.get('if-none-match') === fixture.headers.etag) return new Response(null, { status: 304, headers: { etag: fixture.headers.etag! } })
    return Response.json(fixture.body, { headers: fixture.headers })
  }
  return { fetch, requests }
}

const drive = async (forge: NodeForge, job: ImportJob, state: ImportState) => {
  let progress: GithubProgress | null = null
  const waits: string[] = []
  for (let step = 0; step < 50; step++) {
    const result = await forge.importMetadata(job, { ...state, metadata: { progress } })
    if (result.waitUntil) waits.push(result.waitUntil)
    progress = result.progress as GithubProgress
    if (result.done) return { progress, waits, steps: step + 1 }
  }
  throw new Error('the metadata import did not finish')
}

describe('GitHub metadata import', () => {
  let forge: NodeForge
  let github: ReturnType<typeof fakeGithub>
  let alice: string
  let job: ImportJob
  let state: ImportState
  const etags = { enabled: true }
  const shas: Record<string, string> = {}
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    const source = history()
    Object.assign(shas, source.shas)
    github = fakeGithub(shas, etags)
    const jobs: ImportJob[] = []
    forge = await nodeForge({ fetch: github.fetch, scheduleImport: async (scheduled) => void jobs.push(scheduled) })
    const admin = await bootstrap(forge, BASE)
    for (const user of [{ login: 'alice' }, { login: 'octo' }, { login: 'carl', email: 'carl@example.org' }, { login: 'bob' }]) {
      ids[user.login] = ((await (await call(forge, BASE, 'POST', '/api/admin/users', admin, user)).json()) as { id: string }).id
    }
    alice = ((await (await call(forge, BASE, 'POST', '/api/admin/users/alice/tokens', admin, { scopes: ['repo:admin'] })).json()) as { token: string }).token
    expect((await call(forge, BASE, 'POST', '/api/repos/alice/other/import', alice, { url: 'https://example.org/x.git', metadata: true })).status).toBe(400)
    const started = await call(forge, BASE, 'POST', '/api/repos/alice/site/import', alice, { url: 'https://github.com/acme/site.git', token: 'ghp_test', metadata: true })
    expect(started.status).toBe(202)
    job = jobs[0]!
    expect(job).toMatchObject({ ...repo, authorization: basicAuthorization('git', 'ghp_test'), actor: expect.any(String) })
    state = (await readImportState(forge.storage, repo))!
    expect(state.metadata).toEqual({ progress: null })
    const odb = new ObjectDatabase(forge.storage, repo)
    await odb.ingest(streamOf(gitBytes(source.dir, ['pack-objects', '--stdout', '--all'], '')))
    const changes = ['main', 'feature', 'topic'].map((branch) => ({ name: `refs/heads/${branch}`, oldId: ZERO_ID, newId: shas[branch === 'main' ? 'main' : branch]! }))
    expect((await updateRefs(forge.storage, repo, changes, odb)).ok).toBe(true)
  })

  const api = async <T>(path: string): Promise<T> => {
    const response = await call(forge, BASE, 'GET', `/api/v3/repos/alice/site${path}`, alice)
    expect(response.status, path).toBe(200)
    return (await response.json()) as T
  }

  it('maps GitHub URLs to their REST API', () => {
    expect(githubRepository('https://github.com/acme/site.git')).toEqual({ api: 'https://api.github.com', path: '/repos/acme/site' })
    expect(githubRepository('https://git.example.com/acme/site')).toEqual({ api: 'https://git.example.com/api/v3', path: '/repos/acme/site' })
    expect(githubRepository('https://github.com/acme')).toBeNull()
  })

  it('imports labels, milestones, issues, pull requests, comments, reviews and releases with their numbers', async () => {
    const run = await drive(forge, job, state)
    expect(run.waits).toEqual(['2026-10-18T22:58:26.000Z'])
    expect(run.progress.counts).toEqual({ labels: 2, milestones: 1, pulls: 2, issues: 3, comments: 3, reviews: 2, reviewComments: 2, releases: 1, assets: 1 })
    const apiRequests = github.requests.filter((request) => request.url.startsWith(API))
    expect(apiRequests.every((request) => request.authorization === 'Bearer ghp_test')).toBe(true)
    expect(github.requests.filter((request) => request.url.startsWith(ASSET_HOST)).map((request) => request.authorization)).toEqual([null])

    const issue = await api<Record<string, any>>('/issues/1')
    expect(issue).toMatchObject({ number: 1, title: 'Line 15 is wrong', state: 'open', locked: true, active_lock_reason: 'resolved', created_at: '2026-02-02T08:00:00Z', comments: 1 })
    expect(issue.user.login).toBe('octo')
    expect(issue.labels.map((label: { name: string }) => label.name)).toEqual(['bug'])
    expect(issue.assignees.map((user: { login: string }) => user.login)).toEqual(['octo', 'stranger'])
    expect(issue.milestone).toMatchObject({ number: 1, title: 'v1', due_on: '2026-03-01T08:00:00Z' })
    expect((await api<{ user: { login: string } }[]>('/issues/1/comments')).map((comment) => comment.user.login)).toEqual(['stranger'])

    expect(await api('/pulls/2')).toMatchObject({ number: 2, state: 'closed', merged: true, merge_commit_sha: shas.main, head: { ref: 'feature', sha: shas.feature }, base: { ref: 'main' } })
    expect(await api('/pulls/2/reviews')).toMatchObject([{ state: 'APPROVED', user: { login: 'octo' }, commit_id: shas.feature, submitted_at: '2026-02-04T08:00:00Z' }])
    const fork = await api<Record<string, any>>('/issues/3')
    expect(fork.pull_request).toBeUndefined()
    expect(fork.body).toBe('_Imported from pull request https://github.com/acme/site/pull/3; its commits are not in this repository._\n\nPlease merge')
    expect(await api('/pulls/4')).toMatchObject({ number: 4, state: 'open', draft: true, user: { login: 'carl' }, head: { ref: 'topic', sha: shas.topic }, milestone: { number: 1 } })
    const reviewComments = await api<Record<string, any>[]>('/pulls/4/comments')
    expect(reviewComments).toMatchObject([
      { path: 'src.txt', line: 3, side: 'RIGHT', commit_id: shas.topic, user: { login: 'stranger' }, body: 'Why?' },
      { path: 'src.txt', line: 3, user: { login: 'carlgh' }, in_reply_to_id: reviewComments[0]!.id },
    ])
    expect((await api<{ body: string }[]>('/issues/4/comments')).map((comment) => comment.body)).toEqual(['> On `README.md` line 1:\n\nUnrelated line'])
    expect(await api('/issues/5')).toMatchObject({ state: 'closed', state_reason: 'not_planned', user: { login: 'carl' }, closed_at: '2026-02-10T08:00:00Z' })
    expect((await api<{ name: string }[]>('/labels')).map((label) => label.name).sort()).toEqual(['bug', 'enhancement'])

    const [release] = await api<Record<string, any>[]>('/releases')
    expect(release).toMatchObject({ tag_name: 'v1', name: 'Version 1', created_at: '2026-02-10T16:49:20.000Z', published_at: '2026-02-10T16:52:13.000Z', author: { login: 'octo' } })
    expect(release!.assets).toMatchObject([{ name: 'tool.bin', label: 'Tool', size: asset.length, digest: `sha256:${sha256Hex(asset)}`, uploader: { login: 'stranger' } }])
    const stored = await forge.storage.get(lfsObjectKey(repo, sha256Hex(asset)))
    expect(await readAll(stored!.body)).toEqual(asset)
  })

  it('skips unchanged pages by ETag and never duplicates items on a second run', async () => {
    const before = github.requests.length
    const run = await drive(forge, job, state)
    expect(run.progress.counts).toEqual({})
    expect(github.requests.length - before).toBe(10)
    etags.enabled = false
    expect((await drive(forge, job, state)).progress.counts).toEqual({})
    expect((await api<unknown[]>('/issues/1/comments')).length).toBe(1)
    expect((await api<unknown[]>('/pulls/4/comments')).length).toBe(2)
    expect((await readRefs(forge.storage, repo))?.state.refs['refs/heads/main']).toBe(shas.main)
  })

  it('needs repository admin access of the user who started the import', async () => {
    expect(job.actor).toBe(ids.alice)
    await expect(forge.importMetadata({ ...job, actor: ids.bob! }, state)).rejects.toThrow('Not Found')
    await expect(forge.importMetadata({ ...job, actor: 'nobody' }, state)).rejects.toThrow('no longer exists')
    await expect(forge.importMetadata({ owner: repo.owner, name: repo.name }, state)).rejects.toThrow('no longer exists')
  })
})
