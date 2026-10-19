import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitFails, tempDir } from '../e2e/history.ts'
import { type Instance, startInstance } from '../support/federated-instance.ts'

let alpha: Instance
const tokens: Record<string, string> = {}

const call = async (token: string | null, method: string, path: string, body?: unknown): Promise<number> =>
  (
    await fetch(`${alpha.url}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  ).status

const url = (who: string | null, repository: string) => `${who ? alpha.url.replace('http://', `http://git:${tokens[who]}@`) : alpha.url}/${repository}.git`

const commit = async (dir: string, file: string): Promise<string> => {
  writeFileSync(join(dir, file), `${file}\n`)
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', file])
  return (await git(dir, ['rev-parse', 'HEAD'])).trim()
}

const seed = async (name: string, visibility: string): Promise<string> => {
  expect(await alpha.api('POST', '/api/repos', { owner: 'village', name, visibility }).then((response) => response.status)).toBe(201)
  const dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  await commit(dir, 'first.txt')
  await git(dir, ['push', '-q', alpha.gitUrl(`village/${name}`, true), 'main'])
  return dir
}

beforeAll(async () => {
  alpha = await startInstance('alpha')
  for (const login of ['friend', 'stranger']) {
    expect((await alpha.api('POST', '/api/admin/users', { login })).status).toBe(201)
    tokens[login] = ((await (await alpha.api('POST', `/api/admin/users/${login}/tokens`, { scopes: ['repo:admin'] })).json()) as { token: string }).token
  }
}, 60_000)

afterAll(async () => {
  await alpha?.close()
})

describe('fork isolation with real git', () => {
  it('denies a private fork once its owner loses access to the upstream and keeps it private', async () => {
    const source = await seed('secret', 'private')
    expect((await alpha.api('PUT', '/api/repos/village/secret/collaborators/friend', { role: 'write' })).status).toBe(200)
    expect(await call(tokens.friend!, 'POST', '/api/v3/repos/village/secret/forks', {})).toBe(202)
    const dir = tempDir()
    await git(dir, ['clone', '-q', url('friend', 'friend/secret'), 'out'])
    const work = join(dir, 'out')
    await commit(work, 'fork.txt')
    await git(work, ['push', '-q', 'origin', 'main'])
    expect(await call(tokens.friend!, 'PATCH', '/api/v3/repos/friend/secret', { private: false })).toBe(422)
    expect(await call(tokens.friend!, 'PATCH', '/api/repos/friend/secret', { visibility: 'public' })).toBe(422)

    await commit(source, 'after.txt')
    await git(source, ['push', '-q', alpha.gitUrl('village/secret', true), 'main'])
    const [repository, friend] = await Promise.all([alpha.store.findRepository('village', 'secret'), alpha.store.findAccount('friend')])
    await alpha.store.removeCollaborator(repository!.id, friend!.id)

    expect(await gitFails(tempDir(), ['clone', '-q', url('friend', 'friend/secret'), 'out'])).toMatch(/not found|404/)
    expect(await gitFails(work, ['push', 'origin', 'main:other'])).toMatch(/not found|404/)
    expect(await call(tokens.friend!, 'GET', '/api/v3/repos/friend/secret')).toBe(404)
    expect(await call(tokens.friend!, 'PATCH', '/api/v3/repos/friend/secret', { private: false })).toBe(404)
    expect(await call(null, 'GET', '/api/v3/repos/friend/secret')).toBe(404)
    expect((await alpha.api('PUT', '/api/repos/village/secret/collaborators/friend', { role: 'read' })).status).toBe(200)
    await git(tempDir(), ['clone', '-q', url('friend', 'friend/secret'), 'out'])
  })

  it('detaches public forks of a repository that turns private and keeps them to their own objects', async () => {
    const source = await seed('open', 'public')
    const forked = (await git(source, ['rev-parse', 'HEAD'])).trim()
    expect(await call(tokens.stranger!, 'POST', '/api/v3/repos/village/open/forks', {})).toBe(202)
    expect((await alpha.api('PATCH', '/api/repos/village/open', { visibility: 'private' })).status).toBe(200)
    const later = await commit(source, 'private.txt')
    await git(source, ['push', '-q', alpha.gitUrl('village/open', true), 'main'])

    const clone = join(tempDir(), 'out')
    await git(tempDir(), ['clone', '-q', '--bare', url(null, 'stranger/open'), clone])
    expect((await git(clone, ['rev-parse', 'main'])).trim()).toBe(forked)
    expect(await gitFails(clone, ['cat-file', '-e', later])).toBe('')
    expect(await gitFails(clone, ['fetch', '-q', 'origin', later])).toMatch(/not our ref/)
    expect(await call(null, 'GET', '/stranger/open.git/objects/info/packs')).toBe(404)
    expect(await alpha.store.forkInfo((await alpha.store.findRepository('stranger', 'open'))!.id)).toBeNull()
    expect(await call(tokens.stranger!, 'PATCH', '/api/v3/repos/stranger/open', { private: true })).toBe(200)
    await git(tempDir(), ['clone', '-q', url('stranger', 'stranger/open'), 'out'])
    expect(await call(tokens.stranger!, 'PATCH', '/api/v3/repos/stranger/open', { private: false })).toBe(200)
  })
})
