import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lfsObjectKey, ObjectDatabase, type RepositoryName } from '@git-forge/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MirrorOverview } from '../../src/mirror-verification.ts'
import { git, gitFails, tempDir } from '../e2e/history.ts'
import { type Instance, quiesce, startInstance } from '../support/federated-instance.ts'

const repo: RepositoryName = { owner: 'village', name: 'archive' }
const repository = 'village/archive'

const lfsConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
  ['lfs.locksverify', 'false'],
].flatMap(([key, value]) => ['-c', `${key}=${value}`])

const lfsGit = (cwd: string, args: readonly string[]) => git(cwd, [...lfsConfig, ...args])

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const ok = async (response: Promise<Response>, status = 200): Promise<Response> => {
  const resolved = await response
  if (resolved.status !== status) throw new Error(`expected ${status}, got ${resolved.status}: ${await resolved.text()}`)
  return resolved
}

let alpha: Instance
let beta: Instance
const tokens: Record<'anonymous' | 'reader' | 'outsider' | 'admin', string | null> = { anonymous: null, reader: null, outsider: null, admin: null }
type Who = keyof typeof tokens
const blobs = { docs: randomBytes(3000), hidden: randomBytes(3000), asset: randomBytes(3000) }
const oids = { docs: sha256(blobs.docs), hidden: sha256(blobs.hidden), asset: sha256(blobs.asset) }
const tips: Record<'main' | 'release' | 'wip', string> = { main: '', release: '', wip: '' }

const headers = (who: Who): Record<string, string> => (tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {})
const get = (who: Who, path: string) => fetch(`${alpha.url}${path}`, { headers: headers(who), redirect: 'manual' })
const cloneUrl = (who: Who) => (tokens[who] ? alpha.url.replace('http://', `http://git:${tokens[who]}@`) : alpha.url) + `/${repository}.git`

const proactive = ['-c', 'http.proactiveAuth=basic']

const lsRemote = async (who: Who): Promise<string[]> =>
  (await git(tempDir(), [...(tokens[who] ? proactive : []), 'ls-remote', cloneUrl(who)]))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t')[1]!)
    .sort()

const batch = async (who: Who, oid: string): Promise<string> => {
  const response = await fetch(`${alpha.url}/${repository}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: { ...headers(who), Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
    body: JSON.stringify({ operation: 'download', objects: [{ oid, size: 3000 }] }),
  })
  if (response.status !== 200) return String(response.status)
  const [object] = ((await response.json()) as { objects: { actions?: unknown; error?: { code: number } }[] }).objects
  return object!.actions ? 'ok' : String(object!.error?.code)
}

const user = async (login: string): Promise<string> => {
  await ok(alpha.api('POST', '/api/admin/users', { login }), 201)
  return ((await (await ok(alpha.api('POST', `/api/admin/users/${login}/tokens`, { scopes: ['repo:read'] }), 201)).json()) as { token: string }).token
}

const commitAll = async (dir: string, message: string): Promise<string> => {
  await lfsGit(dir, ['add', '-A'])
  await lfsGit(dir, ['commit', '-q', '-m', message])
  return (await git(dir, ['rev-parse', 'HEAD'])).trim()
}

beforeAll(async () => {
  ;[alpha, beta] = await Promise.all([startInstance('alpha'), startInstance('beta')])
  tokens.admin = alpha.token
  tokens.reader = await user('reader')
  tokens.outsider = await user('outsider')
  for (const name of ['archive', 'closed']) await ok(alpha.api('POST', '/api/repos', { owner: 'village', name }), 201)
  await ok(beta.api('POST', '/api/repos', { owner: 'village', name: 'archive' }), 201)
  await ok(alpha.api('POST', '/api/admin/instances', { issuer: beta.url }))
  await ok(beta.api('POST', '/api/admin/instances', { issuer: alpha.url }))

  const source = tempDir()
  await git(source, ['init', '-q', '-b', 'main'])
  await lfsGit(source, ['lfs', 'track', '*.bin'])
  mkdirSync(join(source, 'docs'))
  writeFileSync(join(source, 'secret.txt'), 'top secret\n')
  writeFileSync(join(source, 'docs/guide.md'), '# Guide\n')
  writeFileSync(join(source, 'docs/manual.bin'), blobs.docs)
  writeFileSync(join(source, 'hidden.bin'), blobs.hidden)
  tips.main = await commitAll(source, 'main')
  await git(source, ['checkout', '-q', '-b', 'wip'])
  writeFileSync(join(source, 'wip.txt'), 'work in progress\n')
  tips.wip = await commitAll(source, 'wip')
  await git(source, ['checkout', '-q', '--orphan', 'release'])
  await git(source, ['rm', '-rqf', '--cached', '.'])
  await git(source, ['clean', '-fdxq'])
  await lfsGit(source, ['lfs', 'track', '*.bin'])
  writeFileSync(join(source, 'release.txt'), 'release notes\n')
  writeFileSync(join(source, 'asset.bin'), blobs.asset)
  tips.release = await commitAll(source, 'release')
  await git(source, ['tag', 'v1'])
  await lfsGit(source, ['push', '-q', alpha.gitUrl(repository, true), 'main', 'wip', 'release', 'v1'])

  const rules = [
    { refs: 'refs/heads/release', audience: 'public' },
    { refs: 'refs/tags/*', audience: 'public' },
    { refs: 'refs/heads/main', path: 'docs', audience: 'user', subject: 'reader' },
    { refs: 'refs/heads/main', audience: 'instance', subject: beta.url },
  ]
  for (const rule of rules) await ok(alpha.api('POST', `/api/repos/${repository}/visibility`, rule), 201)
  await ok(beta.api('POST', `/api/repos/${repository}/mirrors`, { url: alpha.gitUrl(repository), auth: 'instance' }), 201)
  await quiesce([alpha, beta])
}, 120_000)

afterAll(async () => {
  await Promise.all([alpha, beta].filter(Boolean).map((instance) => instance.close()))
})

describe('partial visibility', () => {
  it('advertises only visible refs to git and refuses dumb HTTP', async () => {
    const all = ['HEAD', 'refs/heads/main', 'refs/heads/release', 'refs/heads/wip', 'refs/tags/v1']
    const visible = ['HEAD', 'refs/heads/release', 'refs/tags/v1']
    expect(await lsRemote('admin')).toEqual(all)
    for (const who of ['anonymous', 'outsider', 'reader'] as const) expect(await lsRemote(who)).toEqual(visible)
    for (const who of ['anonymous', 'reader'] as const) {
      expect((await get(who, `/${repository}.git/info/refs`)).status).toBe(404)
      expect((await get(who, `/${repository}.git/objects/info/packs`)).status).toBe(404)
    }
    expect((await get('admin', `/${repository}.git/objects/info/packs`)).status).toBe(200)
  })

  it('clones only objects reachable from visible refs, with LFS', async () => {
    const dir = tempDir()
    await lfsGit(dir, ['clone', '-q', cloneUrl('anonymous'), 'out'])
    const out = join(dir, 'out')
    expect(readFileSync(join(out, 'asset.bin')).equals(blobs.asset)).toBe(true)
    expect((await git(out, ['rev-parse', 'HEAD'])).trim()).toBe(tips.release)
    for (const id of [tips.main, tips.wip]) await gitFails(out, ['cat-file', '-e', id])
    expect(await gitFails(out, ['fetch', '-q', 'origin', tips.main])).toMatch(/not our ref|couldn't find|upload-pack/i)

    const full = tempDir()
    await lfsGit(full, [...proactive, 'clone', '-q', cloneUrl('admin'), 'out'])
    expect(readFileSync(join(full, 'out', 'hidden.bin')).equals(blobs.hidden)).toBe(true)
  })

  it('serves LFS objects only under visible refs and paths', async () => {
    const expected: Record<Who, [string, string, string]> = {
      anonymous: ['404', '404', 'ok'],
      outsider: ['404', '404', 'ok'],
      reader: ['ok', '404', 'ok'],
      admin: ['ok', 'ok', 'ok'],
    }
    for (const who of Object.keys(expected) as Who[]) {
      expect([await batch(who, oids.docs), await batch(who, oids.hidden), await batch(who, oids.asset)]).toEqual(expected[who])
    }
    expect((await get('reader', `/${repository}.git/info/lfs/objects/${oids.docs}`)).status).toBe(200)
    expect((await get('reader', `/${repository}.git/info/lfs/objects/${oids.hidden}`)).status).toBe(404)
    expect((await get('anonymous', `/${repository}/media/${oids.asset}/asset.bin`)).status).toBe(200)
    expect((await get('anonymous', `/${repository}/media/${oids.hidden}/hidden.bin`)).status).toBe(404)
  })

  it('serves raw files only under visible refs and paths', async () => {
    const cases: [string, Record<Who, number>][] = [
      ['release/release.txt', { anonymous: 200, outsider: 200, reader: 200, admin: 200 }],
      [`${tips.release}/release.txt`, { anonymous: 200, outsider: 200, reader: 200, admin: 200 }],
      ['main/docs/guide.md', { anonymous: 404, outsider: 404, reader: 200, admin: 200 }],
      [`${tips.main}/docs/guide.md`, { anonymous: 404, outsider: 404, reader: 200, admin: 200 }],
      ['main/secret.txt', { anonymous: 404, outsider: 404, reader: 404, admin: 200 }],
      ['wip/wip.txt', { anonymous: 404, outsider: 404, reader: 404, admin: 200 }],
      [`${tips.wip}/docs/guide.md`, { anonymous: 404, outsider: 404, reader: 404, admin: 200 }],
    ]
    for (const [path, expected] of cases) {
      for (const who of Object.keys(expected) as Who[]) expect([path, who, (await get(who, `/${repository}/raw/${path}`)).status]).toEqual([path, who, expected[who]])
    }
    expect((await get('reader', `/${repository}/raw/main/docs/manual.bin`)).status).toBe(302)
  })

  it('lists and finds partially visible repositories, and keeps the rules to admins', async () => {
    const names = async (who: Who, path: string) => ((await (await ok(get(who, path))).json()) as { items: { owner: string; name: string }[] }).items.map((item) => item.name).sort()
    for (const who of ['anonymous', 'outsider', 'reader'] as const) {
      expect(await names(who, '/api/repos')).toEqual(['archive'])
      expect(await names(who, '/api/search?type=repositories&q=archive')).toEqual(['archive'])
      expect(await names(who, '/api/search?type=repositories&q=closed')).toEqual([])
    }
    expect(await names('admin', '/api/repos')).toEqual(['archive', 'closed'])
    expect((await get('reader', `/api/repos/${repository}/visibility`)).status).toBeGreaterThanOrEqual(403)
    expect(((await (await ok(get('admin', `/api/repos/${repository}/visibility`))).json()) as unknown[]).length).toBe(4)
    expect((await get('anonymous', `/api/repos/${repository}/mirrors/overview`)).status).toBeGreaterThanOrEqual(401)
  })

  it('mirrors exactly what the trusted instance may see and attests it as current', async () => {
    const odb = new ObjectDatabase(beta.storage, repo)
    expect(await odb.has(tips.main)).toBe(true)
    expect(await odb.has(tips.release)).toBe(true)
    expect(await odb.has(tips.wip)).toBe(false)
    for (const oid of Object.values(oids)) expect(await beta.storage.head(lfsObjectKey(repo, oid))).not.toBeNull()
    const refs = (await git(tempDir(), ['ls-remote', beta.gitUrl(repository, true)])).split('\n').map((line) => line.split('\t')[1]).filter(Boolean)
    expect(refs).toEqual(expect.arrayContaining(['refs/upstream/origin/heads/main', 'refs/upstream/origin/heads/release', 'refs/upstream/origin/tags/v1']))
    expect(refs.some((ref) => ref!.includes('wip'))).toBe(false)
    const view = (await (await ok(alpha.api('GET', `/api/repos/${repository}/mirrors/overview`))).json()) as MirrorOverview
    expect(view.mirrors).toEqual([expect.objectContaining({ issuer: beta.url, subscribed: true, state: 'current' })])
    expect(alpha.jobs.failed).toEqual([])
    expect(beta.jobs.failed).toEqual([])
  })
})
