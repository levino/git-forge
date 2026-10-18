import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitFails, tempDir } from './history.ts'
import { startWranglerDev, type WranglerDev } from './wrangler-dev.ts'

const BOOTSTRAP_TOKEN = `e2e-${crypto.randomUUID()}`

let dev: WranglerDev
let owner: string
let reviewer: string
let work: string
let remote: string

type Json = Record<string, any>

const call = async (method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: Json }> => {
  const response = await fetch(`${dev.url}${path}`, {
    method,
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Json) }
}

const write = (name: string, content: string) => writeFileSync(join(work, name), content)

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}\n`).join('')

const commit = async (message: string) => {
  await git(work, ['add', '-A'])
  await git(work, ['commit', '-q', '-m', message])
}

beforeAll(async () => {
  dev = await startWranglerDev({ vars: { BOOTSTRAP_TOKEN } })
  const bootstrapped = await fetch(`${dev.url}/api/bootstrap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'owner' }),
  })
  owner = ((await bootstrapped.json()) as { token: string }).token
  expect((await call('POST', '/api/admin/users', owner, { login: 'reviewer' })).status).toBe(201)
  reviewer = (await call('POST', '/api/admin/users/reviewer/tokens', owner, { scopes: ['repo:write'] })).body.token
  expect((await call('POST', '/api/repos', owner, { owner: 'owner', name: 'site' })).status).toBe(201)
  expect((await call('PUT', '/api/repos/owner/site/collaborators/reviewer', owner, { role: 'write' })).status).toBe(200)
  work = tempDir()
  remote = `${dev.url.replace('http://', `http://git:${owner}@`)}/owner/site.git`
  await git(work, ['init', '-q', '-b', 'main'])
  write('README.md', lines(30))
  write('app.txt', lines(10))
  await commit('initial')
  await git(work, ['checkout', '-q', '-b', 'feature'])
  write('README.md', lines(30).replace('line 25\n', 'feature line\n'))
  await commit('feature: readme\n\nFixes #1')
  await git(work, ['checkout', '-q', '-b', 'clash', 'main'])
  write('app.txt', lines(10).replace('line 3\n', 'clash\n'))
  await commit('clash')
  await git(work, ['checkout', '-q', 'main'])
  write('app.txt', lines(10).replace('line 3\n', 'main\n'))
  await commit('main moves')
  await git(work, ['push', '-q', remote, 'main', 'feature', 'clash'])
}, 120_000)

afterAll(async () => {
  await dev?.stop()
})

describe('collaboration on wrangler dev with real git', () => {
  it('opens an issue and a pull request through /api/v3', async () => {
    expect((await call('POST', '/api/v3/repos/owner/site/issues', reviewer, { title: 'README needs a feature line' })).body.number).toBe(1)
    const pull = await call('POST', '/api/v3/repos/owner/site/pulls', reviewer, { title: 'Feature line', head: 'feature', base: 'main' })
    expect(pull.status).toBe(201)
    expect(pull.body).toMatchObject({ number: 2, mergeable: true, mergeable_state: 'clean', commits: 1, changed_files: 1, head: { sha: (await git(work, ['rev-parse', 'feature'])).trim() } })
    const files = await call('GET', '/api/v3/repos/owner/site/pulls/2/files', owner)
    expect(files.body.map((file: Json) => file.filename)).toEqual(['README.md'])
    const diff = await fetch(`${dev.url}/api/v3/repos/owner/site/pulls/2`, { headers: { Authorization: `token ${owner}`, Accept: 'application/vnd.github.diff' } })
    expect(await diff.text()).toBe(await git(work, ['diff', '--no-indent-heuristic', 'main...feature']))
  })

  it('requires approval, dismisses stale approvals on push and merges like git', async () => {
    const protection = await call('PUT', '/api/repos/owner/site/branches/main/protection', owner, {
      required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true },
      enforce_admins: true,
      required_status_checks: null,
      restrictions: null,
    })
    expect(protection.status).toBe(200)
    const blocked = await call('PUT', '/api/v3/repos/owner/site/pulls/2/merge', owner, {})
    expect(blocked.status).toBe(405)
    expect(blocked.body.message).toMatch(/approving review is required/)
    expect((await call('POST', '/api/v3/repos/owner/site/pulls/2/reviews', owner, { event: 'APPROVE' })).status).toBe(200)
    await git(work, ['checkout', '-q', 'feature'])
    write('notes.txt', 'more\n')
    await commit('feature: notes')
    await git(work, ['checkout', '-q', 'main'])
    await git(work, ['push', '-q', remote, 'feature'])
    const reviews = await call('GET', '/api/v3/repos/owner/site/pulls/2/reviews', reviewer)
    expect(reviews.body.map((review: Json) => review.state)).toEqual(['DISMISSED'])
    expect((await call('GET', '/api/v3/repos/owner/site/pulls/2', reviewer)).body).toMatchObject({ mergeable_state: 'blocked', head: { sha: (await git(work, ['rev-parse', 'feature'])).trim() } })
    expect((await call('POST', '/api/v3/repos/owner/site/pulls/2/reviews', owner, { event: 'APPROVE', body: 'Still good' })).status).toBe(200)
    await git(work, ['checkout', '-q', '-b', 'direct', 'main'])
    write('direct.txt', 'direct\n')
    await commit('direct push')
    await git(work, ['checkout', '-q', 'main'])
    expect(await gitFails(work, ['push', remote, 'direct:main'])).toMatch(/protected branch: changes must be made through a pull request/)
    const merged = await call('PUT', '/api/v3/repos/owner/site/pulls/2/merge', reviewer, { merge_method: 'merge', sha: (await git(work, ['rev-parse', 'feature'])).trim() })
    expect(merged.status).toBe(200)
    await git(work, ['fetch', '-q', remote, 'main:refs/remotes/forge/main'])
    expect((await git(work, ['rev-parse', 'forge/main'])).trim()).toBe(merged.body.sha)
    expect((await git(work, ['rev-parse', 'forge/main^1', 'forge/main^2'])).trim().split('\n')).toEqual([(await git(work, ['rev-parse', 'main'])).trim(), (await git(work, ['rev-parse', 'feature'])).trim()])
    await git(work, ['checkout', '-q', '-b', 'expected', 'main'])
    await git(work, ['merge', '-q', '--no-ff', '-m', 'local', 'feature'])
    expect((await git(work, ['rev-parse', 'forge/main^{tree}'])).trim()).toBe((await git(work, ['rev-parse', 'expected^{tree}'])).trim())
    await git(work, ['checkout', '-q', 'main'])
    const clone = tempDir()
    await git(clone, ['clone', '-q', remote, 'site'])
    await git(join(clone, 'site'), ['fsck', '--strict', '--no-dangling'])
    expect((await git(join(clone, 'site'), ['log', '-1', '--format=%B'])).trim()).toBe('Merge pull request #2 from owner/feature\n\nFeature line')
    expect((await call('GET', '/api/v3/repos/owner/site/issues/1', reviewer)).body).toMatchObject({ state: 'closed', state_reason: 'completed' })
    expect((await call('GET', '/api/v3/repos/owner/site/pulls/2', reviewer)).body).toMatchObject({ merged: true, state: 'closed', merged_by: { login: 'reviewer' } })
  })

  it('reports conflicts and squash-merges a clean branch like git merge --squash', async () => {
    const clash = await call('POST', '/api/v3/repos/owner/site/pulls', reviewer, { title: 'Clash', head: 'clash', base: 'main' })
    expect(clash.body).toMatchObject({ mergeable: false, mergeable_state: 'dirty', merge_conflicts: [{ path: 'app.txt', reason: 'content' }] })
    expect((await call('PUT', '/api/v3/repos/owner/site/pulls/3/merge', owner, {})).status).toBe(405)
    await git(work, ['checkout', '-q', '-b', 'tweak', 'forge/main'])
    write('README.md', lines(30).replace('line 25\n', 'feature line\n').replace('line 1\n', 'tweaked\n'))
    write('tweak.txt', 'tweak\n')
    await commit('tweak one')
    write('tweak.txt', 'tweak, again\n')
    await commit('tweak two')
    await git(work, ['checkout', '-q', 'main'])
    await git(work, ['push', '-q', remote, 'tweak'])
    expect((await call('POST', '/api/v3/repos/owner/site/pulls', reviewer, { title: 'Tweak', head: 'tweak', base: 'main' })).body.number).toBe(4)
    expect((await call('POST', '/api/v3/repos/owner/site/pulls/4/reviews', owner, { event: 'APPROVE' })).status).toBe(200)
    const squashed = await call('PUT', '/api/v3/repos/owner/site/pulls/4/merge', reviewer, { merge_method: 'squash' })
    expect(squashed.status).toBe(200)
    await git(work, ['fetch', '-q', remote, 'main:refs/remotes/forge/main'])
    expect((await git(work, ['rev-parse', 'forge/main^@'])).trim().split('\n')).toHaveLength(1)
    expect((await git(work, ['rev-parse', 'forge/main^{tree}'])).trim()).toBe((await git(work, ['rev-parse', 'tweak^{tree}'])).trim())
    expect((await git(work, ['log', '-1', '--format=%B', 'forge/main'])).trim()).toBe('Tweak (#4)\n\n* tweak one\n\n* tweak two')
  })
})
